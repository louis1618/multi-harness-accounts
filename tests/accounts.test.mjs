import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { AccountManager } from "../.test-build/server/manager.js";
import { createAdapters, transferHistory, authorizationUrl, defaultBrowser } from "../.test-build/server/adapters.js";
import { ActionSchema, SnapshotSchema } from "../.test-build/shared/accounts.js";
import { Store } from "../.test-build/server/store.js";

const secret = "fake-secret-never-in-rpc";
async function temporary(t) {
  const root = await mkdtemp(join(process.env.TEST_WORK_ROOT ?? tmpdir(), "paseo-accounts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function waitFor(check) {
  for (let i = 0; i < 80; i++) { if (await check()) return; await delay(25); }
  assert.fail("Timed out waiting for native login");
}
async function fixture(root, loginDelay = 100) {
  const command = join(root, "native-harness");
  const opener = join(root, "default-browser");
  await writeFile(opener, `#!/usr/bin/env node
import {writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
if(process.env.BROWSER) throw Error('browser bridge was inherited');
if(!process.argv[2].startsWith('https://')) throw Error('invalid browser URL');
if(process.cwd().startsWith(${JSON.stringify(root)}))writeFileSync(join(process.cwd(),'browser-opened'),'native-browser-flow');appendFileSync(join(${JSON.stringify(root)},'browser-count'),'x');
`, {mode:0o700});
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2);
const codex = args[0] !== 'auth';
const dir = process.env[codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'];
const file = join(dir, codex ? 'auth.json' : '.credentials.json');
if (args.includes('status')) {
  console.log(JSON.stringify({loggedIn: existsSync(file), email:'fixture@example.com'}));
  process.exit(existsSync(file) ? 0 : 1);
}
if (args.includes('logout')) { rmSync(file, {force:true}); process.exit(0); }
if (!args.includes('login')) process.exit(2);
for (const key of ['OPENAI_API_KEY','CODEX_ACCESS_TOKEN','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN']) {
  if (process.env[key]) throw Error('credential environment leaked');
}
execFileSync(process.env.BROWSER,['https://auth.openai.com/oauth/authorize?state=fixture']);
setTimeout(() => writeFileSync(file, JSON.stringify({tokens:{access_token:'${secret}',
  id_token:'x.'+Buffer.from(JSON.stringify({email:'fixture@example.com'})).toString('base64url')+'.x'}})), ${loginDelay});
`, { mode: 0o700 });
  return createAdapters({ codex: command, claude: command }, opener);
}
async function transcript(home, harness, id, text) {
  const path = harness === "codex" ? join(home, "sessions", "2026", "09", `rollout-2026-09-30T12-00-00-${id}.jsonl`) :
    join(home, "projects", "-project", `${id}.jsonl`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
  return path;
}

test("native processes use independent homes; RPC, switching, overrides, deferred reloads and history survive", async t => {
  const root = await temporary(t);
  const adapters = await fixture(root);
  for (const harness of ["codex", "claude"]) adapters[harness].systemHome = join(root, `system-${harness}`);
  const agents = new Map();
  const restarted = [];
  const requests = [];
  let manager;
  const paseo = { agents: {
    async list() { return { entries: [...agents.values()].map(agent => ({agent})), pageInfo: {hasMore:false,nextCursor:null} }; },
    ref(id) { return { async refresh() { return agents.has(id) ? {agent:agents.get(id)} : null; } }; },
  }};
  manager = new AccountManager({root:join(root,"accounts"), adapters, restart:async id => {
    const agent = agents.get(id);
    const request = await manager.openSession({agentId:id,provider:agent.provider,cwd:root,workspaceId:null,
      reason:"refresh",purpose:"interactive",env:{UNCHANGED:"yes"}}, paseo);
    requests.push(request); restarted.push(id);
  }});
  t.after(() => manager.dispose());
  for(const harness of ["codex","claude"]){
    await mkdir(adapters[harness].systemHome,{recursive:true});
    await writeFile(join(adapters[harness].systemHome,harness==="codex"?"auth.json":".credentials.json"),JSON.stringify({tokens:{
      access_token:secret,id_token:'x.'+Buffer.from(JSON.stringify({email:'outside@example.test'})).toString('base64url')+'.x',
    }}));
  }
  const nativeBefore=await readFile(join(adapters.codex.systemHome,"auth.json"),"utf8");
  const outside=await manager.snapshot(paseo);
  assert.equal(outside.accounts.length,0);
  assert.equal(outside.systemAccounts.length,2);
  assert.ok(outside.systemAccounts.every(a=>a.status==="signed-in"));
  assert.equal(outside.systemAccounts.find(a=>a.harness==="codex").email,"outside@example.test");
  assert.ok(!JSON.stringify(outside).includes(secret));
  const oldBrowser=process.env.BROWSER;
  process.env.BROWSER="/coding-agent-browser-bridge";
  try {
    await Promise.all([
      manager.change({action:"add",harness:"codex",label:"Personal"},paseo),
      manager.change({action:"add",harness:"claude",label:"Claude work"},paseo),
    ]);
  }finally{
    if(oldBrowser===undefined)delete process.env.BROWSER;else process.env.BROWSER=oldBrowser;
  }
  await assert.rejects(manager.change({action:"add",harness:"codex",label:"Concurrent"},paseo),/진행 중인 브라우저 로그인/);
  await waitFor(async () => (await manager.snapshot(paseo)).accounts.every(a => a.status === "signed-in"));
  await manager.change({action:"add",harness:"codex",label:"Work"},paseo);
  await waitFor(async () => (await manager.snapshot(paseo)).accounts.every(a => a.status === "signed-in"));
  const snapshot = await manager.snapshot(paseo);
  SnapshotSchema.parse(snapshot);
  assert.equal(await readFile(join(adapters.codex.systemHome,"auth.json"),"utf8"),nativeBefore);
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  const [personal, work] = snapshot.accounts.filter(a => a.harness === "codex");
  const claude = snapshot.accounts.find(a => a.harness === "claude");
  for (const account of snapshot.accounts) {
    assert.equal(await readFile(join(manager.profile(account),"browser-opened"),"utf8"),"native-browser-flow");
    assert.equal((await stat(manager.profile(account))).mode & 0o777,0o700);
  }
  assert.equal((await stat(join(manager.store.root,"metadata.json"))).mode & 0o777,0o600);
  assert.ok(!JSON.stringify(await manager.store.read()).includes(secret));
  await manager.change({action:"select",harness:"codex",accountId:personal.id},paseo);
  const sessionId = randomUUID();
  agents.set("agent-one",{id:"agent-one",provider:"codex",title:"One",status:"idle",persistence:{sessionId},activeTurn:null});
  const first = await manager.openSession({agentId:"agent-one",provider:"codex",cwd:root,workspaceId:null,
    reason:"create",purpose:"interactive",env:{OTHER:"preserved",OPENAI_API_KEY:"wrong-key"}},paseo);
  assert.equal(first.env.CODEX_HOME,manager.profile(personal));
  assert.equal(first.env.OPENAI_API_KEY,"");
  assert.equal(first.env.OTHER,"preserved");
  const file = await transcript(manager.profile(personal),"codex",sessionId,"original conversation\n");
  await manager.change({action:"select",harness:"codex",accountId:work.id},paseo);
  assert.deepEqual(restarted,["agent-one"]);
  assert.equal(requests.at(-1).env.CODEX_HOME,manager.profile(work));
  const relativeFile = file.slice(manager.profile(personal).length);
  assert.equal(await readFile(manager.profile(work)+relativeFile,"utf8"),"original conversation\n");
  assert.equal((await manager.store.read()).pending["agent-one"],undefined);
  assert.equal(agents.get("agent-one").persistence.sessionId,sessionId);
  await manager.change({action:"select",harness:"codex",agentId:"agent-one",accountId:personal.id},paseo);
  restarted.length=0;
  await manager.change({action:"select",harness:"codex",accountId:work.id},paseo);
  assert.deepEqual(restarted,[]); // Explicit override is unaffected by global selection.
  agents.get("agent-one").status="running";
  agents.get("agent-one").activeTurn={turnId:"turn-one"};
  await manager.change({action:"inherit",agentId:"agent-one"},paseo);
  assert.deepEqual(restarted,[]);
  assert.ok((await manager.store.read()).pending["agent-one"]);
  agents.get("agent-one").status="idle"; agents.get("agent-one").activeTurn=null;
  await manager.applyPending("agent-one",paseo);
  assert.equal(requests.at(-1).env.CODEX_HOME,manager.profile(work));
  await manager.change({action:"relogin",id:work.id},paseo);
  await waitFor(async () => (await manager.snapshot(paseo)).accounts.find(a=>a.id===work.id).status==="signed-in");
  await waitFor(async () => !(await manager.store.read()).pending["agent-one"]);
  assert.equal(await readFile(manager.profile(work)+relativeFile,"utf8"),"original conversation\n");
  await assert.rejects(manager.change({action:"select",harness:"claude",agentId:"agent-one",accountId:claude.id},paseo),/다른 코딩 에이전트/);
  await assert.rejects(manager.change({action:"remove",id:work.id},paseo),/에이전트가 열려/);
  agents.get("agent-one").status="closed";
  await manager.change({action:"remove",id:work.id},paseo);
  await assert.rejects(stat(manager.profile(work)),{code:"ENOENT"});
  const stored = await manager.store.read();
  assert.ok(!stored.accounts.some(a=>a.id===work.id));
  assert.ok(stored.bindings["agent-one"].home.includes("history"));
  const resumed = await manager.openSession({agentId:"agent-one",provider:"codex",cwd:root,workspaceId:null,
    reason:"resume",purpose:"interactive",env:{}},paseo);
  assert.equal(resumed.env.CODEX_HOME,adapters.codex.systemHome);
  assert.equal(await readFile(adapters.codex.systemHome+relativeFile,"utf8"),"original conversation\n");
  const reloadManager = new AccountManager({root:manager.store.root,adapters,restart:async id=>{
    await reloadManager.openSession({agentId:id,provider:"codex",cwd:root,workspaceId:null,reason:"refresh",purpose:"interactive",env:{}},paseo);
    throw Error("safe restart failure");
  }});
  t.after(()=>reloadManager.dispose());
  agents.get("agent-one").status="idle";
  await reloadManager.change({action:"select",harness:"codex",accountId:personal.id},paseo);
  assert.match((await reloadManager.snapshot(paseo)).agents[0].error,/계정 작업에 실패/);
  assert.ok((await new Store(manager.store.root).read()).accounts.some(a=>a.id===personal.id));
  await manager.change({action:"add",harness:"codex",label:"Canceled"},paseo);
  const canceled=(await manager.store.read()).accounts.find(a=>a.label==="Canceled");
  await manager.change({action:"cancel-login",id:canceled.id},paseo);
  await manager.change({action:"remove",id:canceled.id},paseo);
  assert.ok(!(await manager.store.read()).accounts.some(a=>a.id===canceled.id));
});

test("Claude transcript and subagent migration excludes credentials and unrelated sessions; invalid input and symlinks fail closed", async t => {
  const root=await temporary(t), source=join(root,"source"), target=join(root,"target"), id=randomUUID();
  const file=await transcript(source,"claude",id,"conversation\n");
  await transcript(source,"claude",randomUUID(),"unrelated\n");
  await mkdir(join(source,"projects","-project",id,"subagents"),{recursive:true});
  await writeFile(join(source,"projects","-project",id,"subagents","agent-child.jsonl"),"child history\n");
  await writeFile(join(source,".credentials.json"),secret);
  await transferHistory("claude",source,target,id);
  assert.equal(await readFile(file.replace(source,target),"utf8"),"conversation\n");
  assert.equal(await readFile(join(target,"projects","-project",id,"subagents","agent-child.jsonl"),"utf8"),"child history\n");
  await assert.rejects(stat(join(target,".credentials.json")),{code:"ENOENT"});
  assert.throws(()=>ActionSchema.parse({action:"remove",id:"../../auth.json"}));
  assert.throws(()=>ActionSchema.parse({action:"add",harness:"codex",label:" ",token:secret}));
  await assert.rejects(transferHistory("codex",source,target,randomUUID()),/원본 대화 기록을 찾지/);
  await symlink(source,join(root,"symlink-home"));
  await assert.rejects(new Store(join(root,"symlink-home")).read(),/계정 디렉터리가 안전하지/);
  await symlink(join(source,"projects"),join(source,"sessions"));
  await assert.rejects(transferHistory("codex",source,target,id),/대화 기록 디렉터리가 안전하지/);
  const unsafeProfile=join(root,"unsafe-profile");
  await mkdir(unsafeProfile);
  await symlink(join(source,".credentials.json"),join(unsafeProfile,"auth.json"));
  await assert.rejects(createAdapters().codex.prepare(unsafeProfile),/설정 또는 인증 파일이 안전하지/);
  const store=new Store(join(root,"corrupt"));
  await store.update(()=>{});
  await writeFile(join(store.root,"metadata.json"),"{ broken");
  await assert.rejects(store.update(state=>{state.accounts=[];}),/읽을 수 없습니다/);
  assert.equal(await readFile(join(store.root,"metadata.json"),"utf8"),"{ broken");
});

test("native Claude discovery preserves whether CLAUDE_CONFIG_DIR was set", async t => {
  const root=await temporary(t), command=join(root,"native-status");
  await writeFile(command,`#!/usr/bin/env node
console.log(JSON.stringify({loggedIn:true,email:Object.hasOwn(process.env,'CLAUDE_CONFIG_DIR')?'env-set@example.test':'env-unset@example.test'}));
`,{mode:0o700});
  const adapter=createAdapters({claude:command}).claude;
  const status=await adapter.status(adapter.systemHome,true);
  assert.equal(status.email,Object.hasOwn(process.env,'CLAUDE_CONFIG_DIR')?'env-set@example.test':'env-unset@example.test');
});


test("authorization links are temporary, allowlisted, reopen on the host and never enter metadata", async t => {
  const root=await temporary(t), adapters=await fixture(root,2000), manager=new AccountManager({root:join(root,'accounts'),adapters});t.after(()=>manager.dispose());
  const paseo={agents:{async list(){return {entries:[],pageInfo:{hasMore:false,nextCursor:null}};}}};
  const link='https://auth.openai.com/oauth/authorize?state=fixture';assert.equal(authorizationUrl(link),link);
  for(const url of ['javascript:alert(1)','https://evil.example/oauth/authorize','https://auth.openai.com/oauth/token?access_token=secret','https://auth.openai.com/oauth/authorize?access_token=secret','https://auth.openai.com/oauth/authorize?code=secret'])assert.equal(authorizationUrl(url),null);
  assert.ok(authorizationUrl('https://claude.ai/oauth/authorize?code=true&state=fixture'));
  assert.ok(authorizationUrl('https://claude.com/cai/oauth/authorize?code=true&state=fixture'));
  assert.equal(authorizationUrl('https://claude.com/cai/oauth/token?access_token=secret'),null);
  for(const harness of ['codex','claude']) {
    const before=await readFile(join(root,'browser-count'),'utf8').then(text=>text.length).catch(()=>0);
    await manager.change({action:'add',harness,label:'Fixture '+harness},paseo);
    let row;await waitFor(async()=>{row=(await manager.snapshot(paseo)).accounts.find(a=>a.harness===harness);return row?.authUrl===link;});
    assert.equal(row.status,'authenticating');assert.ok(!JSON.stringify(await manager.store.read()).includes(link));
    const home=manager.profile(row);const files=(await readdir(home)).filter(name=>name.startsWith('.auth-url-'));assert.equal(files.length,1);assert.equal((await stat(join(home,files[0]))).mode&0o777,0o600);
    await waitFor(async()=>await readFile(join(root,'browser-count'),'utf8').then(text=>text.length===before+1).catch(()=>false));
    await manager.change({action:'open-login-browser',harness,accountId:row.id},paseo);assert.equal((await readFile(join(root,'browser-count'),'utf8')).length,before+2);
    await manager.change({action:'cancel-login',id:row.id},paseo);assert.equal((await manager.snapshot(paseo)).accounts.find(a=>a.id===row.id).authUrl,null);
    await assert.rejects(manager.change({action:'open-login-browser',harness,accountId:row.id},paseo),/종료/);
    await waitFor(async()=>!(await readdir(home)).some(name=>name.startsWith('.auth-url-')));
  }
  const launcher=await defaultBrowser();if(process.platform==='linux'){assert.ok(launcher.command==='/usr/bin/gio'||launcher.command==='/usr/bin/xdg-open');}
});

test("CLI runtime errors are not treated as signed-out responses", async t => {
  const root=await temporary(t), command=join(root,'status-fixture');
  await writeFile(command, '#!/usr/bin/env node\nconsole.log(JSON.stringify({error:"runtime failed"}));process.exit(2);\n', {mode:0o700});
  const adapters=createAdapters({codex:command,claude:command});
  await assert.rejects(adapters.claude.status(root),/확인하지 못했습니다/);
  await assert.rejects(adapters.codex.status(root,true),/확인하지 못했습니다/);
  await writeFile(command, '#!/usr/bin/env node\nconsole.log(JSON.stringify({loggedIn:false}));process.exit(1);\n', {mode:0o700});
  assert.equal((await adapters.claude.status(root)).signedIn,false);
  await writeFile(command, '#!/usr/bin/env node\nconsole.error("Not logged in");process.exit(1);\n', {mode:0o700});
  assert.equal((await adapters.codex.status(root,true)).signedIn,false);
});
