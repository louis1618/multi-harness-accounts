// Only temporary fixture files are created or modified. No user file is used.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { HomeFiles } from '../.check-build/server/files.js';
import { actionRpc } from '../.check-build/shared/files.js';
const fixture = await mkdtemp(join(tmpdir(), 'home-finder-check-'));
const home = join(fixture, 'home'); await mkdir(home); await writeFile(join(home, 'hello.txt'), 'hello 한글'); await writeFile(join(home, '.hidden'), 'hidden'); await writeFile(join(fixture, 'outside.txt'), 'outside'); await symlink(fixture, join(home, 'escape'));
const files = new HomeFiles(home, join(fixture, 'preferences'));
try {
 const list = await files.list({path:'',hidden:false,trash:false}); assert.equal(list.entries.length,2); assert.equal(list.entries.find(r=>r.name==='escape').accessible,false);
 assert.equal((await files.list({path:'',hidden:true,trash:false})).entries.length,3);
 await assert.rejects(files.list({path:'..',hidden:true,trash:false})); await assert.rejects(files.preview({path:'escape/outside.txt'}));
 assert.equal(actionRpc.input.safeParse({action:'rename',path:'hello.txt',name:'../bad'}).success,false);
 assert.equal(actionRpc.input.safeParse({action:'trash',paths:['hello.txt']}).success,false);
 assert.equal((await files.change({action:'mkdir',path:'',name:'Folder'})).errors.length,0);
 assert.equal((await files.change({action:'favorite',path:'hello.txt',enabled:true})).errors.length,0);
 assert.equal((await files.change({action:'rename',path:'hello.txt',name:'renamed.txt'})).errors.length,0);
 assert.equal((await files.list({path:'',hidden:false,trash:false})).favorites[0].path,'renamed.txt');
 assert.equal((await files.change({action:'copy',paths:['renamed.txt'],destination:'Folder',move:false})).errors.length,0);
 assert.equal((await files.change({action:'copy',paths:['renamed.txt'],destination:'Folder',move:false})).errors.length,1);
 assert.equal((await files.preview({path:'Folder/renamed.txt'})).text,'hello 한글');
 if(process.platform==='linux') {
  assert.equal((await files.change({action:'trash',paths:['renamed.txt'],confirmed:true})).errors.length,0);
  const trash=await files.list({path:'',hidden:false,trash:true}); assert.equal(trash.entries.length,1); assert.equal(trash.entries[0].originalPath,'renamed.txt');
  await writeFile(join(home,'renamed.txt'),'keep'); assert.equal((await files.change({action:'restore',paths:[trash.entries[0].path]})).errors.length,1); assert.equal(await readFile(join(home,'renamed.txt'),'utf8'),'keep');
  await rm(join(home,'renamed.txt')); assert.equal((await files.change({action:'restore',paths:[trash.entries[0].path]})).errors.length,0); assert.equal(await readFile(join(home,'renamed.txt'),'utf8'),'hello 한글');
 }

 // URL streaming uses a descriptor snapshot, never a public path/file browser.
 const linked = await files.link({path:'Folder/renamed.txt',download:true});
 const request = (url, options={}) => fetch(url,{...options,signal:AbortSignal.timeout(5000)});
 assert.equal((await files.link({path:'Folder/renamed.txt',download:true})).url,linked.url);
 assert.equal(await (await request(linked.url)).text(),'hello 한글');
 const head=await request(linked.url,{method:'HEAD'});assert.equal(head.status,200);assert.match(head.headers.get('content-disposition'),/^attachment/);assert.equal(Number(head.headers.get('content-length')),Buffer.byteLength('hello 한글'));
 const ranged=await request(linked.url,{headers:{Range:'bytes=0-4'}});assert.equal(ranged.status,206);assert.equal(await ranged.text(),'hello');assert.match(ranged.headers.get('content-range'),/^bytes 0-4\//);
 const suffix=await request(linked.url,{headers:{Range:'bytes=-3'}});assert.equal(suffix.status,206);assert.equal((await suffix.arrayBuffer()).byteLength,3);
 for(const range of ['bytes=-0','bytes=999-','bytes=3-1','bytes=0-1,4-5'])assert.equal((await request(linked.url,{headers:{Range:range}})).status,416);
 assert.equal((await request(new URL('/file/'+ '0'.repeat(64)+'/anything',linked.url))).status,403);
 assert.equal((await request(new URL('/etc/passwd',linked.url))).status,403);
 await assert.rejects(files.link({path:'escape/outside.txt',download:true}));
 await assert.rejects(files.urlSetting({baseUrl:'https://user:password@example.com'}));await assert.rejects(files.urlSetting({baseUrl:'file:///etc'}));
 assert.equal((await files.urlSetting({})).baseUrl,null);await files.urlSetting({baseUrl:'https://files.example.com/base/'});assert.equal((await files.urlSetting({})).baseUrl,'https://files.example.com/base');await files.urlSetting({baseUrl:null});
 const dateNow=Date.now;try{Date.now=()=>dateNow()+31*60000;assert.equal((await request(linked.url)).status,403);}finally{Date.now=dateNow;}
 await writeFile(join(home,'Folder/renamed.txt'),'changed');assert.equal((await request(linked.url)).status,409);
 const execute=promisify(execFile);
 await execute('python3',['-c',`import zipfile,sys
with zipfile.ZipFile(sys.argv[1]+'/sample.docx','w') as z:z.writestr('word/document.xml','<document><p><t>Office preview</t></p></document>')
with zipfile.ZipFile(sys.argv[1]+'/sample.xlsx','w') as z:z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><v>42</v></c></row></sheetData></worksheet>')
with zipfile.ZipFile(sys.argv[1]+'/sample.zip','w') as z:z.writestr('../untrusted.txt','Do not extract')`,home]);
 assert.match((await files.preview({path:'sample.docx'})).text,/Office preview/);assert.match((await files.preview({path:'sample.xlsx'})).text,/A1: 42/);assert.match((await files.preview({path:'sample.zip'})).text,/untrusted.txt/);
 await writeFile(join(home,'utf16.txt'),Buffer.concat([Buffer.from([255,254]),Buffer.from('한글','utf16le')]));assert.equal((await files.preview({path:'utf16.txt'})).text,'한글');
 await writeFile(join(home,'fake.mp4'),Buffer.from([0,1,2,3]));const movie=await files.preview({path:'fake.mp4'});assert.equal(movie.kind,'video');assert.ok(movie.url);assert.match((await request(movie.url,{method:'HEAD'})).headers.get('content-type'),/^video\/mp4/);
 await writeFile(join(home,'sample.html'),'<script>alert(1)</script>');assert.equal((await files.preview({path:'sample.html'})).kind,'text');
 console.log('Home Finder check passed: home boundary, selection contracts, favorites, rename, copy, preview, URL byte transfer, trash/restore, streaming URLs/ranges/expiry, Office/archive preview and UTF-16.');
} finally { await files.dispose(); await rm(fixture,{recursive:true,force:true}); }
