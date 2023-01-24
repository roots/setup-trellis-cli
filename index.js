const cache = require('@actions/cache');
const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs');
const glob = require('@actions/glob');
const http = require('@actions/http-client');
const io = require('@actions/io');
const tc = require('@actions/tool-cache');
const os = require('os');
const path = require('path');
const process = require('process');

function isExactCacheKeyMatch(key, cacheKey) {
  return !!(cacheKey && cacheKey.localeCompare(key, undefined, { sensitivity: "accent" }) === 0);
}

async function getRelease(version) {
  let osPlatform = os.platform();
  const platformMappings = {
    'win32': 'windows'
  };
  osPlatform = platformMappings[osPlatform] || osPlatform;

  let osArch = os.arch();
  const archMappings = {
    x32: 'i386',
    x64: 'x86_64'
  };
  osArch = archMappings[osArch] || osArch;

  core.debug(`Finding release for ${version} (${osPlatform}_${osArch})`);
  const release = await fetchRelease(version);

  if (!release.name) {
    core.info(`API response: ${JSON.stringify(release)}`);
    throw new Error(`No trellis-cli release found for version ${version}`);
  }

  core.debug(`Release ${release.name} (tag: ${release.tag_name}) found.`);

  const asset = release.assets.find((asset) => {
    if (asset.browser_download_url.match(new RegExp(osArch, 'i')) && asset.browser_download_url.match(new RegExp(osPlatform, 'i'))) {
      return asset;
    }
  });

  if (!asset) {
    throw new Error(`No trellis-cli binary found for platform ${osPlatform} or arch ${osArch}.`);
  }

  return {
    version: release.tag_name,
    url: asset.browser_download_url,
  }
}

async function fetchRelease(version) {
  const client = new http.HttpClient('setup-trellis-cli-client');

  let headers = {};
  if (process.env.GITHUB_TOKEN) {
    headers['authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let url = null;

  if (version === 'latest' || version === '') {
    url = `https://api.github.com/repos/roots/trellis-cli/releases/latest`;
  } else {
    url = `https://api.github.com/repos/roots/trellis-cli/releases/tags/${version}`;
  }

  const response = await client.get(url, headers);
  const body = await response.readBody();
  return JSON.parse(body);
}

async function downloadRelease(release) {
  const downloadPath = await tc.downloadTool(release.url);
  core.debug(`Downloaded to ${downloadPath}`);

  const cliPath = await tc.extractTar(downloadPath);
  core.debug(`Extracted to ${cliPath}`);

  const cachePath = await tc.cacheDir(cliPath, 'trellis-cli', release.version);
  core.debug(`Cached to ${cachePath}`);

  return cachePath;
}

async function ensurePython3() {
  try {
    const python3Path = await io.which('python3', true);
    core.debug(`python3 found at ${python3Path}`);

    if (core.isDebug()) {
      await exec.exec('python3 --version');
    }
  } catch(error) {
    const msg = `
      Python not found and is a required dependency for using trellis-cli and Trellis.

      Add a setup-python step like the one below *before* setup-trellis-cli.

        - uses: actions/setup-python@v2
          with:
            python-version: '3.9'
    `
    throw new Error(msg);
  }
}

async function withCache(cacheable, paths, baseKey, hashPattern) {
  const keyPrefix = `${process.env.RUNNER_OS}-${baseKey}-`;
  const hash = await glob.hashFiles(hashPattern);
  const primaryKey = `${keyPrefix}${hash}`;
  const restoreKeys = [keyPrefix];

  const cacheKey = await cache.restoreCache(paths, primaryKey, restoreKeys);

  if (!cacheKey) {
    core.info(`Cache not found for keys: ${[primaryKey, ...restoreKeys].join(", ")}`);
  } else {
    core.info(`Cache restored from key: ${cacheKey}`);
  }

  await cacheable();

  if (isExactCacheKeyMatch(primaryKey, cacheKey)) {
    core.info(`Cache hit occurred on the primary key ${primaryKey}, not saving cache.`);
    return;
  }

  try {
    await cache.saveCache(paths, primaryKey);
  } catch {
    await cache.saveCache(paths, primaryKey + "-retry");
  }
}

async function cachedInit() {
  return await withCache(async () => {
    await exec.exec('trellis init')
  }, [path.join('.trellis', 'virtualenv')], 'trellis-venv', '**/requirements.txt');
}

async function runGalaxyInstall() {
  return await withCache(async () => {
    await exec.exec('trellis galaxy install')
  }, [path.join('vendor', 'roles')], 'trellis-galaxy', '**/galaxy.yml');
}

async function run() {
  try {
    const ansibleVaultPassword = core.getInput('ansible-vault-password', { required: true});
    const autoInit = core.getBooleanInput('auto-init');
    const cacheVirtualenv = core.getBooleanInput('cache-virtualenv');
    const galaxyInstall = core.getBooleanInput('galaxy-install');
    const trellisPath = core.getInput('trellis-directory') || 'trellis';
    const version = core.getInput('version') || 'latest';

    await core.group('Install trellis-cli', async () => {
      const release = await getRelease(version);
      const cliPath = await downloadRelease(release);
      core.addPath(cliPath);
      core.debug(`Added ${cliPath} to PATH`);
      // don't check for trellis-cli updates
      core.exportVariable('TRELLIS_NO_UPDATE_NOTIFIER', 'true');
      core.info(`trellis-cli ${release.version} installed successfully`);
      core.setOutput('version', release.version);
    });

    await ensurePython3();

    try {
      core.debug(`Changing directories to ${trellisPath}`);
      process.chdir(trellisPath)
    } catch (error) {
      throw new Error(`Could not change directory to ${trellisPath}. Ensure directory exists first.`);
    }

    core.startGroup('Create .vault_pass file')
    if (ansibleVaultPassword != '') {
      fs.writeFileSync('.vault_pass', ansibleVaultPassword, { mode: 0o644 });
      core.info(`Vault password written to .vault_pass file`);
    }
    core.endGroup()

    if (autoInit) {
      core.debug(`auto-init enabled`);

      if (cacheVirtualenv) {
        core.debug(`cache-virtualenv enabled`);

        await core.group('Initialize project', async () => {
          await cachedInit();
        });
      } else {
        await core.group('Initialize project', async () => {
          await exec.exec('trellis init');
        });
      }
    }

    if (galaxyInstall) {
      core.debug(`galaxy-install enabled`);
      await core.group('Install Galaxy roles', async () => {
        await runGalaxyInstall();
      });
    }
  } catch (error) {
    if (error.name === cache.ReserveCacheError.name) {
      core.info(error.message);
    } else {
      core.setFailed(error.message);
    }
  }
}

run();
