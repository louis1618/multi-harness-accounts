// Offline smoke check with the installed CLIs. It never starts an OAuth login or sends a request to a vendor.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createAdapters } from "../.test-build/server/adapters.js";

const execute=promisify(execFile);
const root=await mkdtemp(join(process.env.TEST_WORK_ROOT ?? tmpdir(),"paseo-native-"));
const processes=[];
const server=createServer(async(req,res)=>{
  for await(const chunk of req) {} // Drain the native request; no token or request body is retained.
  if(req.method!=="POST") {res.writeHead(200,{"content-type":"application/json"});res.end('{"data":[]}');return;}
  res.writeHead(200,{"content-type":"text/event-stream"});
  const message={id:"msg_fixture",type:"message",role:"assistant",content:[{type:"output_text",text:"Native history survived."}]};
  for(const [event,data] of [
    ["response.created",{response:{id:"resp_fixture",object:"response",status:"in_progress",output:[]}}],
    ["response.output_item.added",{output_index:0,item:{...message,content:[]}}],
    ["response.output_item.done",{output_index:0,item:message}],
    ["response.completed",{response:{id:"resp_fixture",object:"response",status:"completed",output:[message],usage:{input_tokens:8,output_tokens:4,total_tokens:12}}}],
  ]) res.write(`event: ${event}\ndata: ${JSON.stringify({type:event,...data})}\n\n`);
  res.end();
});
server.listen(0,"127.0.0.1");await once(server,"listening");
const adapters=createAdapters();
async function appServer(home){
  const child=spawn("codex",["app-server"],{env:{...process.env,...adapters.codex.environment(home)},stdio:["pipe","pipe","ignore"]});
  processes.push(child);
  const pending=new Map(), notifications=[];
  let sequence=0;
  createInterface({input:child.stdout}).on("line",line=>{
    let value;try{value=JSON.parse(line);}catch{return;}
    if(value.id!==undefined && pending.has(value.id)){const promise=pending.get(value.id);pending.delete(value.id);
      clearTimeout(promise.timer);value.error?promise.reject(Error(value.error.message)):promise.resolve(value.result);}
    else notifications.push(value);
  });
  child.on("error",()=>{for(const request of pending.values())request.reject(Error("Native Codex could not start."));});
  function request(method,params){
    const id=++sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Native request timed out: ${method}`)),20000);
      pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+"\n");});
  }
  await request("initialize",{clientInfo:{name:"paseo-accounts-smoke",version:"1.0.0"},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:"initialized",params:{}})+"\n");
  return {child,request,notifications};
}
try{
  const homeA=join(root,"codex-a"),homeB=join(root,"codex-b"),claudeHome=join(root,"claude");
  for(const home of [homeA,homeB]){
    await adapters.codex.prepare(home);
    await writeFile(join(home,"config.toml"),`cli_auth_credentials_store = "file"\nmodel_provider = "fixture"\nmodel = "fixture-model"\n[model_providers.fixture]\nname = "Offline fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  }
  await adapters.claude.prepare(claudeHome);
  assert.deepEqual(await adapters.claude.status(claudeHome),{signedIn:false,email:null,identity:null});
  await assert.rejects(execute("codex",["login","status"],{env:{...process.env,...adapters.codex.environment(homeA)},timeout:10000}),error=>error.code===1);
  const first=await appServer(homeA);
  const started=await first.request("thread/start",{cwd:root,model:"fixture-model",approvalPolicy:"never",sandbox:"read-only"});
  const id=started.thread.id;
  await first.request("turn/start",{threadId:id,input:[{type:"text",text:"Record an offline test message.",text_elements:[]}]});
  const deadline=Date.now()+20000;
  while(!first.notifications.some(event=>event.method==="turn/completed")){
    if(Date.now()>deadline)throw Error("Native Codex turn did not complete.");
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const completed=first.notifications.find(event=>event.method==="turn/completed");
  assert.equal(completed.params.turn.status,"completed");
  first.child.kill("SIGTERM");await once(first.child,"exit");
  await adapters.codex.transferHistory(homeA,homeB,id);
  const second=await appServer(homeB);
  const resumed=await second.request("thread/resume",{threadId:id,cwd:root,model:"fixture-model",approvalPolicy:"never",sandbox:"read-only"});
  assert.equal(resumed.thread.id,id);
  assert.ok(JSON.stringify(resumed.thread.turns).includes("Native history survived."));
  console.log("Native smoke passed: isolated Codex/Claude status; real Codex turn and resume across independent homes.");
}finally{
  await Promise.all(processes.map(async child=>{
    if(child.exitCode!==null || child.signalCode!==null)return;
    const ended=once(child,"exit");
    child.kill("SIGTERM");
    const timer=setTimeout(()=>child.kill("SIGKILL"),3000);
    try{await ended;}finally{clearTimeout(timer);}
  }));
  await new Promise(resolve=>server.close(resolve));
  await rm(root,{recursive:true,force:true});
}
