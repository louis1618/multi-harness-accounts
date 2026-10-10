import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {AccountManager,isUsageLimitFailure} from '../.test-build/server/manager.js';
import {createAdapters} from '../.test-build/server/adapters.js';
import {emptyCounter,parseCodexQuota} from '../.test-build/server/usage.js';
import {ActionSchema,SnapshotSchema} from '../.test-build/shared/accounts.js';
import {ScheduleManager} from '../.test-build/server/schedules.js';
const failure=(message="You've hit your usage limit",kind='failed',messageId='manual-message')=>({outcome:kind==='failed'?{kind,error:{message}}:kind==='canceled'?{kind,reason:'user'}:{kind},timeline:[{type:'user_message',text:'Private work prompt',clientMessageId:messageId},{type:'assistant_message',text:message}]});
async function fixture(t,harness='codex'){
 const root=await mkdtemp(join(tmpdir(),'paseo-rotation-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const accounts=['A','Duplicate A','Exhausted','B','Other harness'].map((label,i)=>({id:randomUUID(),harness:i===4?(harness==='codex'?'claude':'codex'):harness,label,createdAt:new Date().toISOString()}));
 const [a,duplicate,full,b]=accounts;const identities=new Map([[a.id,'identity-A'],[duplicate.id,'identity-A'],[full.id,'identity-full'],[b.id,'identity-B']]);
 const quotas=new Map([[a.id,100],[duplicate.id,0],[full.id,100],[b.id,0]]),adapters=createAdapters(),sent=[],reloaded=[],receipts=new Map();
 for(const h of ['codex','claude']){
  adapters[h].systemHome=join(root,'system-'+h);await mkdir(adapters[h].systemHome);
  adapters[h].status=async home=>({signedIn:identities.has(basename(home)),email:'fixture@example.test',identity:identities.get(basename(home))??null});
  adapters[h].quota=async home=>parseCodexQuota({rateLimits:{primary:{usedPercent:quotas.get(basename(home))??100,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}}});
  adapters[h].usage=async()=>({...emptyCounter(),observed:true});
  adapters[h].transferHistory=async(source,target,sessionId)=>{assert.equal(sessionId,agent.persistence.sessionId);await mkdir(target,{recursive:true});};
 }
 const agent={id:'fixture-agent',provider:harness,model:harness==='claude'?'claude-sonnet-4':'gpt-6',cwd:root,title:'Fixture',status:'idle',activeTurn:null,lastUserMessageAt:'2026-10-01T00:00:00.000Z',persistence:{sessionId:randomUUID()},pendingPermissions:[]};
 let onRestart=null,onSend=null,manager;
 const paseo={agents:{list:async()=>({entries:[{agent}],pageInfo:{hasMore:false,nextCursor:null}}),ref:()=>({
  refresh:async()=>({agent}),subscribe:()=>()=>{},timeline:{append:async()=>({seq:1,epoch:'fixture'}),refetch:async()=>({entries:[...receipts].map(([messageId,text])=>({item:{type:'user_message',clientMessageId:messageId,text}}))})},
  send:async(text,options)=>{if(receipts.has(options.messageId))return;assert.equal(options.sendGuard.lastUserMessageAt,agent.lastUserMessageAt);assert.equal(options.sendGuard.sessionId,agent.persistence.sessionId);receipts.set(options.messageId,text);sent.push({text,...options});if(onSend)await onSend(options);},
 })}};
 manager=new AccountManager({root:join(root,'accounts'),adapters,restart:async id=>{
  reloaded.push(id);if(onRestart)await onRestart();
  await manager.openSession({agentId:id,provider:harness,cwd:root,workspaceId:null,reason:'refresh',purpose:'interactive',env:{}},paseo);
 }});t.after(()=>manager.dispose());
 await manager.store.update(state=>{state.accounts=accounts;state.defaults[harness]=a.id;});
 await manager.openSession({agentId:agent.id,provider:harness,cwd:root,workspaceId:null,reason:'create',purpose:'interactive',env:{}},paseo);
 const turn=async(event=failure(),beforeRotation)=>{agent.status='running';agent.activeTurn={turnId:'turn-'+randomUUID()};const id=agent.activeTurn.turnId;
  await manager.beginTurn(agent.id,id,paseo);agent.status='error';agent.activeTurn=null;await manager.endTurn(agent.id,id,paseo,event,beforeRotation?()=>beforeRotation(event,id):undefined);};
 return{root,manager,paseo,agent,accounts,quotas,adapters,sent,reloaded,turn,setRestart:fn=>{onRestart=fn;},setSend:fn=>{onSend=fn;}};
}
test('rotation defaults off and rejects invalid toggle input',async t=>{
 const f=await fixture(t);await f.turn();assert.equal(f.sent.length,0);assert.equal(f.reloaded.length,0);
 const state=await f.manager.snapshot(f.paseo);SnapshotSchema.parse(state);assert.deepEqual(state.rotation,{codex:false,claude:false});
 assert.throws(()=>ActionSchema.parse({action:'set-rotation',harness:'gemini',enabled:true}));
});
test('quota classifier excludes cancellation, transient/network errors and ordinary assistant prose',()=>{
 assert.equal(isUsageLimitFailure(failure()),true);
 assert.equal(isUsageLimitFailure(failure("You’ve hit your usage limit. Try again later.")),true);
 assert.equal(isUsageLimitFailure(failure('API Error: usage_limit_reached')),true);
 for(const event of [failure('socket disconnected'),failure('API Error: 429 Too many requests'),failure("You've hit your usage limit",'canceled'),failure('The documentation says you have hit your limit.','completed')])assert.equal(isUsageLimitFailure(event),false);
 assert.equal(isUsageLimitFailure(failure("You've hit your limit · resets tomorrow",'completed')),true);
});
test('same-harness rotation skips identical identities/exhausted accounts, preserves session, and continues exactly once',async t=>{
 const f=await fixture(t),[a,,,b]=f.accounts;const nativeId=f.agent.persistence.sessionId;
 await f.manager.change({action:'set-rotation',harness:'codex',enabled:true},f.paseo);await f.turn();
 const state=await f.manager.store.read();assert.equal(state.defaults.codex,a.id);assert.equal(state.overrides[f.agent.id],b.id);
 assert.equal(state.bindings[f.agent.id].sessionId,nativeId);assert.equal(state.bindings[f.agent.id].home,join(f.root,'accounts','codex',b.id));
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].sendGuard.provider,'codex');assert.equal(f.reloaded.length,1);
 await f.manager.endTurn(f.agent.id,'duplicate-terminal',f.paseo,failure());assert.equal(f.sent.length,1);
 assert.equal(state.rotations[f.agent.id].phase,'continued');assert.ok(!JSON.stringify(state.rotations).includes('Private work prompt'));
 // B also exhausts; this chain must never go back to A or cross into Claude.
 await f.turn(failure("You've hit your usage limit",'failed',f.sent[0].messageId));
 assert.equal(f.sent.length,1);assert.equal((await f.manager.store.read()).rotations[f.agent.id].phase,'stopped');
 f.quotas.set(a.id,0);await f.manager.change({action:'retry-rotation',agentId:f.agent.id},f.paseo);
 assert.equal(f.sent.length,2);assert.equal((await f.manager.store.read()).overrides[f.agent.id],a.id);
});
test('Claude native limit-as-assistant-message requires exhausted quota, then uses only Claude profiles',async t=>{
 const f=await fixture(t,'claude');await f.manager.change({action:'set-rotation',harness:'claude',enabled:true},f.paseo);
 f.quotas.set(f.accounts[0].id,20);await f.turn(failure("You've hit your limit",'completed'));assert.equal(f.sent.length,0);
 f.quotas.set(f.accounts[0].id,100);await f.turn(failure("You've hit your limit",'completed'));assert.equal(f.sent.length,1);
 assert.match((await f.manager.store.read()).bindings[f.agent.id].home,/claude/);
});
test('toggle off during refresh cancels our own queued switch and preserves inherited selection',async t=>{
 const f=await fixture(t);await f.manager.change({action:'set-rotation',harness:'codex',enabled:true},f.paseo);
 f.setRestart(()=>f.manager.change({action:'set-rotation',harness:'codex',enabled:false},f.paseo));await f.turn();
 const state=await f.manager.store.read();assert.equal(f.sent.length,0);assert.equal(state.pending[f.agent.id],undefined);assert.equal(state.overrides[f.agent.id],undefined);
 assert.equal(state.bindings[f.agent.id].accountId,f.accounts[0].id);assert.equal(state.rotations[f.agent.id].phase,'stopped');
});
test('new user input during candidate lookup prevents refresh and continuation',async t=>{
 const f=await fixture(t);await f.manager.change({action:'set-rotation',harness:'codex',enabled:true},f.paseo);
 const quota=f.adapters.codex.quota;f.adapters.codex.quota=async home=>{if(basename(home)===f.accounts[3].id){f.agent.lastUserMessageAt='2026-10-01T00:01:00.000Z';f.agent.status='running';f.agent.activeTurn={turnId:'new-user-turn'};}return quota(home);};
 await f.turn();assert.equal(f.sent.length,0);assert.equal(f.reloaded.length,0);assert.equal((await f.manager.store.read()).overrides[f.agent.id],undefined);
});
test('unknown acknowledgement reconciles the persisted continuation message instead of sending a duplicate',async t=>{
 const f=await fixture(t);await f.manager.change({action:'set-rotation',harness:'codex',enabled:true},f.paseo);
 f.setSend(()=>{f.agent.lastUserMessageAt='2026-10-01T00:00:10.000Z';throw Error('missing acknowledgement private-secret');});await f.turn();
 assert.equal(f.sent.length,1);assert.equal((await f.manager.store.read()).rotations[f.agent.id].phase,'error');
 await f.manager.change({action:'retry-rotation',agentId:f.agent.id},f.paseo);assert.equal(f.sent.length,1);
 assert.ok(!JSON.stringify((await f.manager.snapshot(f.paseo)).agents).includes('private-secret'));
});
test('pending approval blocks automatic refresh and continuation',async t=>{
 const f=await fixture(t);await f.manager.change({action:'set-rotation',harness:'codex',enabled:true},f.paseo);
 f.agent.pendingPermissions=[{id:'existing-approval'}];await f.turn();
 assert.equal(f.sent.length,0);assert.equal(f.reloaded.length,0);
 assert.equal((await f.manager.store.read()).rotations[f.agent.id].phase,'stopped');
});

test('unknown, missing, failed, and still-exhausted candidate limits never rotate or send',async t=>{
 for(const mode of ['throw','error','loading','unavailable','auth-required','empty','full-past-reset']){
  const f=await fixture(t),b=f.accounts[3],base=f.adapters.codex.quota;
  f.adapters.codex.quota=async home=>{
   const q=await base(home);if(basename(home)!==b.id)return q;
   if(mode==='throw')throw Error('private-native-error');
   if(mode==='empty')return {...q,windows:[]};
   if(mode==='full-past-reset')return parseCodexQuota({rateLimits:{primary:{usedPercent:100,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)-1}}});
   return {...q,status:mode};
  };
  await f.manager.change({action:'set-rotation',harness:'codex',enabled:true},f.paseo);await f.turn();
  assert.equal(f.sent.length,0,mode);assert.equal(f.reloaded.length,0,mode);
  assert.equal((await f.manager.store.read()).bindings[f.agent.id].accountId,f.accounts[0].id,mode);
 }
});
test('capacity is checked again before switching and after reopening the provider',async t=>{
 for(const phase of ['before-switch','after-switch']){
  const f=await fixture(t),b=f.accounts[3],base=f.adapters.codex.quota;let reads=0;
  f.adapters.codex.quota=async home=>{const q=await base(home);if(basename(home)===b.id&&++reads>=(phase==='before-switch'?2:3))return {...q,status:'error'};return q;};
  await f.manager.change({action:'set-rotation',harness:'codex',enabled:true},f.paseo);await f.turn();
  assert.equal(f.sent.length,0);assert.equal(f.reloaded.length,phase==='before-switch'?0:1);
  assert.equal((await f.manager.store.read()).rotations[f.agent.id].phase,'stopped');
 }
});
test('the current model ignores unrelated model quotas but requires a known applicable limit',async t=>{
 const f=await fixture(t,'claude'),base=f.adapters.claude.quota,b=f.accounts[3];
 f.adapters.claude.quota=async home=>{const q=await base(home);if(basename(home)!==b.id)return q;return {...q,windows:[...q.windows,{...q.windows[0],id:'opus',scope:'opus',usedPercent:100}]};};
 await f.manager.change({action:'set-rotation',harness:'claude',enabled:true},f.paseo);await f.turn();assert.equal(f.sent.length,1);
});
test('current-account reservation is created before independent rotation and survives when the next limit is unknown',async t=>{
 for(const canRotate of [false,true]){
  const f=await fixture(t,'claude'),base=f.adapters.claude.quota,b=f.accounts[3];
  if(!canRotate)f.adapters.claude.quota=async home=>{const q=await base(home);return basename(home)===b.id?{...q,status:'unavailable'}:q;};
  const schedules=new ScheduleManager(f.manager);await schedules.start(f.paseo,true);t.after(()=>schedules.dispose());
  await schedules.change({action:'automatic',agentId:f.agent.id,enabled:true});
  await f.manager.change({action:'set-rotation',harness:'claude',enabled:true},f.paseo);
  let pinned;
  await f.turn(failure(),async(event,id)=>{await schedules.turnEnded(f.agent.id,event,id);pinned=Object.values((await f.manager.store.read()).schedules.jobs)[0];});
  assert.equal(pinned.accountId,f.accounts[0].id);assert.equal(pinned.message,'Continue');assert.equal(pinned.status,'waiting');
  await schedules.kick();
  const job=Object.values((await f.manager.store.read()).schedules.jobs)[0];
  assert.equal(job.status,canRotate?'canceled':'waiting');assert.equal(f.sent.length,canRotate?1:0);
 }
});
