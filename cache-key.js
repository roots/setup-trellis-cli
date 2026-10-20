import * as exec from '@actions/exec';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Identity of the python3 interpreter that `trellis init` builds the virtualenv with.
 *
 * @typedef {object} PythonIdentity
 * @property {string} executable Fully resolved path of the interpreter binary.
 * @property {string} baseExecutable Unresolved path the virtualenv links bin/python3 to.
 * @property {string} version Full Python version (e.g. 3.13.7).
 * @property {string} extSuffix Extension module suffix, which carries the ABI and architecture.
 * @property {string} osRelease Distribution and release from /etc/os-release (e.g. ubuntu-24.04).
 */

/**
 * Parses the output of python-identity.py.
 *
 * @param {string} stdout Output of the identity script.
 * @returns {PythonIdentity} Interpreter identity.
 * @throws {Error} When the output is not a valid identity.
 */
export function parsePythonIdentity(stdout) {
  const lastLine = stdout.trim().split('\n').pop();
  let identity;

  try {
    identity = JSON.parse(lastLine);
  } catch {
    throw new Error(`Unexpected Python identity output: ${stdout}`);
  }

  const fields = ['executable', 'baseExecutable', 'version', 'extSuffix', 'osRelease'];

  if (!fields.every((field) => typeof identity?.[field] === 'string') || !/^\d+\.\d+\.\d+/.test(identity.version)) {
    throw new Error(`Unexpected Python identity output: ${stdout}`);
  }

  return identity;
}

/**
 * Reads the identity of the python3 interpreter on PATH.
 *
 * @returns {Promise<PythonIdentity>} Interpreter identity.
 * @throws {Error} When python-identity.py cannot be read, or python3 fails or prints an unexpected identity.
 */
export async function getPythonIdentity() {
  const script = fs.readFileSync(new URL('./python-identity.py', import.meta.url), 'utf8');
  const { exitCode, stdout, stderr } = await exec.getExecOutput('python3', ['-I', '-S', '-c', script], {
    ignoreReturnCode: true,
    silent: true,
  });

  if (exitCode !== 0) {
    throw new Error(`python3 exited with code ${exitCode}: ${stderr.trim()}`);
  }

  return parsePythonIdentity(stdout);
}

/**
 * Builds the base cache key for the trellis-cli virtualenv.
 *
 * A virtualenv links bin/python3 to the interpreter path it was created with
 * and writes its own absolute path into its scripts, so it is only valid for
 * that interpreter, at that path, on that OS release, at that location. The
 * key hashes all of them, so a change to any is a cache miss. The
 * `trellis-virtualenv` base keeps these entries out of the `trellis-venv-`
 * restore prefix that older releases of this action use.
 *
 * @param {PythonIdentity} identity Interpreter identity.
 * @param {string} virtualenvPath Absolute path of the virtualenv.
 * @returns {string} Base cache key.
 */
export function virtualenvBaseKey(identity, virtualenvPath) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify([identity.executable, identity.baseExecutable, identity.extSuffix, identity.osRelease, virtualenvPath]))
    .digest('hex')
    .slice(0, 16);

  return `trellis-virtualenv-python${identity.version}-${hash}`;
}

/**
 * Checks that a virtualenv's pyvenv.cfg was written by the given interpreter.
 * `trellis init` reuses an existing virtualenv, which may have been built by
 * a different interpreter than the one the cache key describes.
 *
 * @param {string} pyvenvCfg Contents of the virtualenv's pyvenv.cfg.
 * @param {PythonIdentity} identity Interpreter identity.
 * @returns {boolean} Whether the virtualenv belongs to the interpreter.
 */
export function virtualenvMatchesInterpreter(pyvenvCfg, identity) {
  const config = Object.fromEntries(
    pyvenvCfg
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const [key, ...value] = line.split('=');
        return [key.trim(), value.join('=').trim()];
      }),
  );

  if (config.home !== path.dirname(identity.baseExecutable)) {
    return false;
  }

  return config.executable === undefined || config.executable === identity.executable;
}
