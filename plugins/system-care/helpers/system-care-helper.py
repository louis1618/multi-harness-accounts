#!/usr/bin/python3 -I
"""Fixed, privileged maintenance operations. No path or command arguments."""
import json, os, subprocess, sys
ACTIONS = {
    'apt-autoclean': ['/usr/bin/apt-get', '-o', 'Dir::Cache::archives=/var/cache/apt/archives', 'autoclean'],
    'journal-vacuum': ['/usr/bin/journalctl', '--vacuum-time=30d'],
}
def command(action):
    if action not in ACTIONS:
        raise ValueError('unsupported action')
    return ACTIONS[action][:]
def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ACTIONS:
        print(json.dumps({'ok': False, 'error': 'unsupported_action'})); return 2
    if os.geteuid() != 0:
        print(json.dumps({'ok': False, 'error': 'root_required'})); return 3
    try:
        result = subprocess.run(command(sys.argv[1]), env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C','DEBIAN_FRONTEND':'noninteractive'}, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
        print(json.dumps({'ok':result.returncode == 0,'action':sys.argv[1], 'code':result.returncode}))
        return 0 if result.returncode == 0 else 1
    except subprocess.TimeoutExpired:
        print(json.dumps({'ok':False,'error':'timeout'})); return 1
if __name__ == '__main__':
    sys.exit(main())
