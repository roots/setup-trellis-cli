"""Print the identity of the interpreter running this script as JSON.

setup-trellis-cli runs this with `python3 -I -S` and hashes the output into the
trellis-cli virtualenv cache key, so site hooks cannot print anything else.
"""

import json
import os
import platform
import sys
import sysconfig


def os_release():
    try:
        with open('/etc/os-release') as f:
            release = dict(line.rstrip('\n').split('=', 1) for line in f if '=' in line)
    except OSError:
        return ''

    return release.get('ID', '').strip('"') + '-' + release.get('VERSION_ID', '').strip('"')


print(json.dumps({
    'executable': os.path.realpath(sys.executable),
    'baseExecutable': os.path.abspath(getattr(sys, '_base_executable', sys.executable)),
    'version': platform.python_version(),
    'extSuffix': sysconfig.get_config_var('EXT_SUFFIX'),
    'osRelease': os_release(),
}))
