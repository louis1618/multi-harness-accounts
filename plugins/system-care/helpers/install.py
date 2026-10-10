#!/usr/bin/python3 -I
"""Run with pkexec after reviewing this source. Installs only two fixed files."""
import os, pathlib, stat, sys, tempfile
ROOT = pathlib.Path(__file__).resolve().parent
TARGETS = [('system-care-helper.py','/usr/local/libexec/paseo-system-care-helper',0o755),('org.paseo.system-care.policy','/usr/share/polkit-1/actions/org.paseo.system-care.policy',0o644)]
def main():
 if os.geteuid()!=0 or len(sys.argv)!=1: return 2
 for source,target,mode in TARGETS:
  src=ROOT/source
  if src.is_symlink() or not src.is_file() or src.stat().st_size>65536: return 3
  dst=pathlib.Path(target);parent=dst.parent
  if not parent.exists(): parent.mkdir(mode=0o755,parents=True)
  for path in [parent,*parent.parents]:
   st=path.lstat()
   if stat.S_ISLNK(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022: return 3
  if dst.is_symlink(): return 3
  fd,tmp=tempfile.mkstemp(prefix='.system-care-',dir=parent)
  try:
   with os.fdopen(fd,'wb') as f: f.write(src.read_bytes());f.flush();os.fsync(f.fileno())
   os.chown(tmp,0,0);os.chmod(tmp,mode);os.replace(tmp,dst)
  finally:
   if os.path.exists(tmp):os.unlink(tmp)
 print('system-care helper installed; no cleanup performed')
 return 0
if __name__=='__main__':sys.exit(main())
