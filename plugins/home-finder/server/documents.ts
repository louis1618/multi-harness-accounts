import {execFile} from "node:child_process";
import {promisify} from "node:util";
const run=promisify(execFile);
// Read bounded Office/EPUB ZIP XML without extracting files or evaluating macros/formulas.
const reader=String.raw`
import sys,zipfile,xml.etree.ElementTree as E,json,tarfile
p=sys.argv[1]; ext=p.rsplit('.',1)[-1].lower(); lines=[]
def read(z,n):
 i=z.getinfo(n)
 if i.file_size>4*1024*1024:raise ValueError('XML too large')
 return E.fromstring(z.read(n))
if ext in ('zip','docx','xlsx','pptx','odt','ods','odp','epub'):
 with zipfile.ZipFile(p) as z:
  if len(z.infolist())>10000:raise ValueError('Too many entries')
  if ext=='zip': lines=[i.filename+(' /' if i.is_dir() else ' ('+str(i.file_size)+' bytes)') for i in z.infolist()[:300]]
  elif ext=='xlsx':
   ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}; shared=[]
   if 'xl/sharedStrings.xml' in z.namelist():shared=[''.join(x.itertext()) for x in read(z,'xl/sharedStrings.xml')][:10000]
   for n in sorted(x for x in z.namelist() if x.startswith('xl/worksheets/sheet') and x.endswith('.xml'))[:8]:
    lines.append('\n'+n)
    for row in read(z,n).findall('.//s:row',ns)[:120]:
     cells=[]
     for c in list(row)[:40]:
      v=c.find('s:v',ns); val=v.text if v is not None and v.text else ''.join(c.itertext())
      if c.get('t')=='s' and val.isdigit() and int(val)<len(shared):val=shared[int(val)]
      cells.append(c.get('r','')+': '+val)
     lines.append(' | '.join(cells))
  else:
   names=['word/document.xml'] if ext=='docx' else ['content.xml'] if ext in ('odt','ods','odp') else sorted(n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml'))[:30] if ext=='pptx' else [n for n in z.namelist() if n.endswith(('.xhtml','.html'))][:20]
   for n in names:
    if n in z.namelist():lines.extend(text.strip() for text in read(z,n).itertext() if text.strip())
elif ext in ('tar','gz','tgz','bz2','xz'):
 with tarfile.open(p,'r:*') as z:
  for i,item in enumerate(z):
   if i>=300:break
   lines.append(item.name+(' /' if item.isdir() else ' ('+str(item.size)+' bytes)'))
print(json.dumps({'text':'\n'.join(lines)[:100000]},ensure_ascii=False))
`;
export async function documentText(path:string){try{const result=await run("python3",["-c",reader,path],{timeout:10000,maxBuffer:700000});return JSON.parse(result.stdout).text as string;}catch{return null;}}
