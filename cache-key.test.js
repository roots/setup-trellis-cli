import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, test, expect } from 'vitest';
import { getPythonIdentity, parsePythonIdentity, virtualenvBaseKey, virtualenvMatchesInterpreter } from './cache-key.js';

const hasPython3 = (() => {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

const identity = {
  executable: '/opt/hostedtoolcache/Python/3.13.7/x64/bin/python3.13',
  baseExecutable: '/opt/hostedtoolcache/Python/3.13.7/x64/bin/python3',
  version: '3.13.7',
  extSuffix: '.cpython-313-x86_64-linux-gnu.so',
  osRelease: 'ubuntu-24.04',
};
const virtualenvPath = '/home/runner/work/site/site/trellis/.trellis/virtualenv';

function withFakePython3(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-python3-'));
  fs.writeFileSync(path.join(dir, 'python3'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  return dir;
}

describe('getPythonIdentity', () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  test.skipIf(!hasPython3)('reads the identity of the real python3', async () => {
    const parsed = await getPythonIdentity();

    expect(parsed.executable).toMatch(/^\//);
    expect(parsed.baseExecutable).toMatch(/^\//);
    expect(parsed.extSuffix).toMatch(/^\..*\.so$/);
  });

  test('runs the identity script isolated and without site hooks', async () => {
    const dir = withFakePython3(`echo "$1 $2 $3" > "$(dirname "$0")/args"\necho '${JSON.stringify(identity)}'`);

    await expect(getPythonIdentity()).resolves.toEqual(identity);
    expect(fs.readFileSync(path.join(dir, 'args'), 'utf8').trim()).toEqual('-I -S -c');
  });

  test('rejects with the stderr of a failing python3', async () => {
    withFakePython3('echo "pyenv: version 3.11.9 is not installed" >&2\nexit 1');

    await expect(getPythonIdentity()).rejects.toThrow('python3 exited with code 1: pyenv: version 3.11.9 is not installed');
  });
});

describe('parsePythonIdentity', () => {
  test('uses the last line of output', () => {
    const stdout = `notice: something, printed first\n${JSON.stringify(identity)}\n`;

    expect(parsePythonIdentity(stdout)).toEqual(identity);
  });

  test.each([
    ['empty output', ''],
    ['non-JSON output', 'Python 3.13.7'],
    ['a JSON scalar', '3.13'],
    ['an invalid version', JSON.stringify({ ...identity, version: '3.13' })],
    ...['executable', 'baseExecutable', 'version', 'extSuffix', 'osRelease'].map((field) => [
      `a missing ${field}`,
      JSON.stringify({ ...identity, [field]: undefined }),
    ]),
  ])('throws on %s', (_, stdout) => {
    expect(() => parsePythonIdentity(stdout)).toThrow('Unexpected Python identity output');
  });
});

describe('virtualenvBaseKey', () => {
  test('matches the expected key', () => {
    expect(virtualenvBaseKey(identity, virtualenvPath)).toBe('trellis-virtualenv-python3.13.7-a3f9877607a58023');
  });

  test('is stable for the same interpreter and path', () => {
    expect(virtualenvBaseKey({ ...identity }, virtualenvPath)).toEqual(virtualenvBaseKey(identity, virtualenvPath));
  });

  test.each([
    ['Python patch release', { version: '3.13.8', executable: '/opt/hostedtoolcache/Python/3.13.8/x64/bin/python3.13' }],
    ['resolved interpreter path', { executable: '/usr/bin/python3.13' }],
    ['unresolved interpreter path', { baseExecutable: '/usr/local/bin/python3' }],
    ['ABI', { extSuffix: '.cpython-313t-x86_64-linux-gnu.so' }],
    ['architecture', { extSuffix: '.cpython-313-aarch64-linux-gnu.so' }],
    ['OS release', { osRelease: 'ubuntu-22.04' }],
  ])('changes with the %s', (_, change) => {
    expect(virtualenvBaseKey({ ...identity, ...change }, virtualenvPath)).not.toEqual(virtualenvBaseKey(identity, virtualenvPath));
  });

  test('changes with the virtualenv path', () => {
    expect(virtualenvBaseKey(identity, '/home/runner/_work/site/site/trellis/.trellis/virtualenv')).not.toEqual(virtualenvBaseKey(identity, virtualenvPath));
  });
});

describe('virtualenvMatchesInterpreter', () => {
  const pyvenvCfg = [
    'home = /opt/hostedtoolcache/Python/3.13.7/x64/bin',
    'include-system-site-packages = false',
    'version = 3.13.7',
    'executable = /opt/hostedtoolcache/Python/3.13.7/x64/bin/python3.13',
    'command = /opt/hostedtoolcache/Python/3.13.7/x64/bin/python3 -m venv /home/runner/work/site/site/trellis/.trellis/virtualenv',
  ].join('\n');

  test('accepts a virtualenv built by the interpreter', () => {
    expect(virtualenvMatchesInterpreter(pyvenvCfg, identity)).toBe(true);
  });

  test('accepts a pyvenv.cfg without an executable line', () => {
    expect(virtualenvMatchesInterpreter('home = /opt/hostedtoolcache/Python/3.13.7/x64/bin\n', identity)).toBe(true);
  });

  test('rejects a virtualenv built by another interpreter', () => {
    expect(virtualenvMatchesInterpreter(pyvenvCfg.replaceAll('3.13.7', '3.13.6'), identity)).toBe(false);
  });

  test('rejects a virtualenv linked through another path to the same binary', () => {
    expect(virtualenvMatchesInterpreter(pyvenvCfg, { ...identity, baseExecutable: '/usr/local/bin/python3' })).toBe(false);
  });

  test('rejects a missing pyvenv.cfg', () => {
    expect(virtualenvMatchesInterpreter('', identity)).toBe(false);
  });

  test.skipIf(!hasPython3)('accepts a virtualenv built by the real python3', async (context) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venv-'));

    try {
      execFileSync('python3', ['-m', 'venv', '--without-pip', path.join(dir, 'venv')]);
    } catch {
      context.skip();
    }

    const realIdentity = await getPythonIdentity();

    expect(virtualenvMatchesInterpreter(fs.readFileSync(path.join(dir, 'venv', 'pyvenv.cfg'), 'utf8'), realIdentity)).toBe(true);
  });
});
