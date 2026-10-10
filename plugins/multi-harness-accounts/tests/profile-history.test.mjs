import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {repairClaudeFork,ProfileHistoryGuard} from '../.test-build/server/profile-history.js';
import {AccountManager} from '../.test-build/server/manager.js';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'paseo-profile-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'profile'),system=join(root,'system'),audit=join(root,'audit'),parentId=randomUUID(),childId=randomUUID();
 const first=randomUUID(),last=randomUUID();
 const rows=[{type:'user',uuid:first,sessionId:parentId,message:{role:'user',content:'Complete the current work'}},{type:'assistant',uuid:last,sessionId:parentId,message:{role:'assistant',content:[{type:'text',text:'Known original result'}]}}];
 const branch=rows.map(r=>({...r,uuid:randomUUID(),sessionId:childId,forkedFrom:{sessionId:parentId,messageUuid:r.uuid}}));
 for(const p of [home,system])await mkdir(join(p,'projects','project'),{recursive:true});
 const parent=join(home,'projects','project',parentId+'.jsonl'),source=join(system,'projects','project',childId+'.jsonl'),target=join(home,'projects','project',childId+'.jsonl');
 const encode=r=>r.map(x=>JSON.stringify(x)).join('\n')+'\n';
 await writeFile(parent,encode([...rows,{type:'user',uuid:randomUUID(),message:{role:'user',content:'This later request must be removed by rewind'}}]));
 await writeFile(source,encode(branch));
 return {root,home,system,audit,parentId,childId,rows,branch,parent,source,target,encode,repair:()=>repairClaudeFork(home,system,childId,audit)};
}
test('repairs a verified fork in the selected profile despite regenerated message UUIDs and keeps a private backup',async t=>{
 const f=await fixture(t),result=await f.repair();assert.deepEqual(result,{status:'repaired',messages:2});
 assert.equal(await readFile(f.target,'utf8'),await readFile(f.source,'utf8'));
 const [audit]=await readdir(f.audit);assert.equal(await readFile(join(f.audit,audit,'transcript.jsonl'),'utf8'),await readFile(f.source,'utf8'));
 assert.deepEqual(await f.repair(),{status:'present',messages:2});
});
test('mismatched content or a wrong fork boundary is never copied across profiles',async t=>{
 for(const mode of ['content','boundary','missing-parent','missing-fork']){
  const f=await fixture(t);
  if(mode==='content')f.branch[1].message={role:'assistant',content:'Different account data'};
  if(mode==='boundary')f.branch[0].forkedFrom.messageUuid=randomUUID();
  if(mode==='missing-parent')await rm(f.parent);
  if(mode==='missing-fork')delete f.branch[0].forkedFrom;
  await writeFile(f.source,f.encode(f.branch));await assert.rejects(f.repair(),/복구/);
  await assert.rejects(readFile(f.target),{code:'ENOENT'});
 }
});
test('malformed JSON is reported and existing transcripts are never replaced',async t=>{
 const f=await fixture(t);await writeFile(f.source,'{broken-json');await assert.rejects(f.repair(),/JSON/);
 await writeFile(f.target,f.encode([{type:'user',uuid:randomUUID(),message:{role:'user',content:'Newer user-owned work'}}]));
 const original=await readFile(f.target,'utf8');assert.equal((await f.repair()).status,'present');assert.equal(await readFile(f.target,'utf8'),original);
 await writeFile(f.target,'{still-broken');await assert.rejects(f.repair(),/JSON/);assert.equal(await readFile(f.target,'utf8'),'{still-broken');
});
test('links, traversal IDs, and ambiguous transcript locations are rejected',async t=>{
 const f=await fixture(t);await rm(f.source);await symlink(f.parent,f.source);await assert.rejects(f.repair(),/リンク|링크|복구/);
 await assert.rejects(repairClaudeFork(f.home,f.system,'../outside',f.audit),/ID/);
 const g=await fixture(t);await mkdir(join(g.system,'projects','other'));await writeFile(join(g.system,'projects','other',g.childId+'.jsonl'),g.encode(g.branch));await assert.rejects(g.repair(),/여러 위치/);
});
test('an intentionally fresh conversation is left empty when no fork exists',async t=>{
 const f=await fixture(t);await rm(f.source);assert.deepEqual(await f.repair(),{status:'missing',messages:0});await assert.rejects(readFile(f.target),{code:'ENOENT'});
});
async function guardFixture(t){
 const f=await fixture(t);let reloads=0;
 const account={id:randomUUID(),harness:'claude',label:'Selected profile',createdAt:new Date().toISOString()};
 const agent={id:'guard-agent',provider:'claude',status:'idle',activeTurn:null,pendingPermissions:[],archivedAt:null,persistence:{sessionId:f.childId}};
 const manager=new AccountManager({root:join(f.root,'state'),adapters:{claude:{systemHome:f.system}},restart:async()=>{reloads++;await manager.store.update(s=>{delete s.pending[agent.id];s.bindings[agent.id].sessionId=f.childId;});}});t.after(()=>manager.dispose());
 await manager.store.update(s=>{s.accounts=[account];s.bindings[agent.id]={harness:'claude',accountId:account.id,home:f.home,sessionId:f.parentId};});
 let updates;
 const paseo={agents:{ref:()=>({refresh:async()=>({agent}),timeline:{refetch:async()=>({entries:[]})}}),subscribe:fn=>{updates=fn;return()=>{};},list:async()=>({entries:[{agent}],subscription:{release:async()=>{},subscribe:()=>()=>{}}})}};
 const guard=new ProfileHistoryGuard(manager);t.after(()=>guard.dispose());
 return {...f,manager,guard,agent,paseo,reloads:()=>reloads,update:()=>updates?.({kind:'upsert',agent})};
}
test('daemon-owned observation repairs and reloads only the affected idle session once',async t=>{
 const f=await guardFixture(t);await f.guard.start(f.paseo);assert.equal(f.reloads(),1);assert.equal((await f.manager.store.read()).historyRecovery[f.agent.id].status,'recovered');
 f.update();await f.guard.inspect(f.agent.id,f.paseo);assert.equal(f.reloads(),1);
});
test('active work and pending permission requests postpone recovery until idle',async t=>{
 for(const mode of ['running','permission']){
  const f=await guardFixture(t);if(mode==='running'){f.agent.status='running';f.agent.activeTurn={turnId:'ongoing'};}else f.agent.pendingPermissions=[{id:'approval'}];
  await f.guard.inspect(f.agent.id,f.paseo);assert.equal(f.reloads(),0);await assert.rejects(readFile(f.target),{code:'ENOENT'});
  f.agent.status='idle';f.agent.activeTurn=null;f.agent.pendingPermissions=[];await f.guard.inspect(f.agent.id,f.paseo);assert.equal(f.reloads(),1);
 }
});
test('failed verification produces a durable public diagnostic without reloading the session',async t=>{
 const f=await guardFixture(t);await writeFile(f.source,'{bad-json');await f.guard.inspect(f.agent.id,f.paseo);
 const result=(await f.manager.store.read()).historyRecovery[f.agent.id];assert.equal(result.status,'blocked');assert.match(result.message,/JSON/);assert.equal(f.reloads(),0);
});
