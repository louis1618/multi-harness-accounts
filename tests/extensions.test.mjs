import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ExtensionManager } from "../.test-build/server/extensions.js";
import { Store } from "../.test-build/server/store.js";
import { ItemSchema, JobSchema } from "../.test-build/shared/extensions.js";
const sensitive = "fixture-credential-DO-NOT-COPY";
async function put(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
async function fixture(t) {
  const root = await mkdtemp(
    join(process.env.TEST_WORK_ROOT ?? process.cwd(), "paseo-extensions-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, "state"));
  const a = {
      id: randomUUID(),
      harness: "claude",
      label: "A",
      createdAt: new Date().toISOString(),
    },
    b = { ...a, id: randomUUID(), label: "B" },
    codex = { ...a, id: randomUUID(), harness: "codex", label: "C" };
  await store.update((s) => {
    s.accounts.push(a, b, codex);
    s.defaults.claude = b.id;
  });
  let active = false,
    refreshes = 0;
  const manager = {
    store,
    profile: (a) => join(store.root, a.harness, a.id),
    adapters: Object.fromEntries(
      ["codex", "claude"].map((h) => [
        h,
        {
          systemHome: join(root, "system-" + h),
          environment: (p) => ({
            [h === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: p,
          }),
        },
      ]),
    ),
    isAuthenticating: () => false,
    extensionsChanged: async () => {
      refreshes++;
    },
    sessions: async () => ({
      sessions: [
        { id: "project", harness: "claude", cwd: join(root, "project") },
      ],
    }),
  };
  for (const x of [a, b, codex])
    await mkdir(manager.profile(x), { recursive: true });
  await mkdir(join(root, "project"), { recursive: true });
  const command = join(root, "native-cli.cjs");
  await writeFile(
    command,
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),dir=process.env.CLAUDE_CONFIG_DIR||process.env.CODEX_HOME;
if(args[0]==='--version'){console.log('fixture 1.0');process.exit(0);}
if(args[0]!=='plugin')throw Error('MCP inventory must not run native servers');
const claude=!!process.env.CLAUDE_CONFIG_DIR,plugins=path.join(dir,'plugins');fs.mkdirSync(plugins,{recursive:true});
const read=(p,f)=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):f;
fs.appendFileSync(path.join(dir,'commands'),JSON.stringify(args)+'\\n');
if(args[1]==='marketplace'){const p=path.join(plugins,'known_marketplaces.json'),m=read(p,{});if(args[2]==='list'){console.log(JSON.stringify({marketplaces:Object.entries(m).map(([name,v])=>({name,marketplaceSource:{source:v.source.repo}}))}));process.exit(0);}if(args[2]==='remove')delete m[args[3]];else m.team={source:{repo:args[3]}};fs.writeFileSync(p,JSON.stringify(m));console.log('{}');process.exit(0);}
if(args[1]==='list'){console.log(JSON.stringify({installed:[],available:[]}));process.exit(0);}
if(args[2]==='approval@team'&&!args.includes('--accept-command')){console.log(JSON.stringify({shownCommand:{sha256:'a'.repeat(64),command:'echo install safe'}}));process.exit(1);}
const p=path.join(plugins,'installed_plugins.json'),v=read(p,{version:2,plugins:{}}),id=args[2],settings=path.join(dir,'settings.json'),cfg=read(settings,{});cfg.enabledPlugins??={};
if(args[1]==='uninstall'||args[1]==='remove'){delete v.plugins[id];delete cfg.enabledPlugins[id];}
else if(args[1]==='enable'||args[1]==='disable')cfg.enabledPlugins[id]=args[1]==='enable';
else {const cache=path.join(plugins,'cache',id);fs.mkdirSync(cache,{recursive:true});v.plugins[id]=[{scope:'user',version:'1.0',installPath:cache}];cfg.enabledPlugins[id]=true;}
fs.writeFileSync(p,JSON.stringify(v));fs.writeFileSync(settings,JSON.stringify(cfg));console.log('{}');
`,
    { mode: 0o700 },
  );
  const ext = new ExtensionManager(manager, {
    claude: command,
    codex: command,
  });
  t.after(() => ext.dispose());
  const paseo = {
    agents: {
      list: async () => ({
        entries: active
          ? [
              {
                agent: {
                  id: "running",
                  provider: "claude",
                  status: "running",
                  activeTurn: { id: "turn" },
                },
              },
            ]
          : [],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    },
  };
  ext.setPaseo(paseo);
  const target = (x) => ({
    harness: x.harness,
    accountId: x.id,
    scope: "user",
    sessionId: null,
  });
  const finish = async (id) => {
    for (let i = 0; i < 250; i++) {
      const j = (await ext.jobs({})).jobs.find((j) => j.id === id);
      if (j && ["done", "error", "approval", "canceled"].includes(j.status)) {
        JobSchema.parse(j);
        return j;
      }
      await delay(20);
    }
    throw Error("job timeout");
  };
  return {
    root,
    manager,
    ext,
    a,
    b,
    codex,
    target,
    finish,
    setActive: (v) => {
      active = v;
    },
    refreshes: () => refreshes,
  };
}
test("common configuration is additive, redacted, conflict-safe, scoped, reversible and durable", async (t) => {
  const f = await fixture(t),
    { ext, manager, a, b, target, finish } = f,
    A = manager.profile(a),
    B = manager.profile(b);
  await put(join(A, ".credentials.json"), { token: sensitive });
  await put(join(B, ".credentials.json"), { token: "B credential" });
  await put(join(A, ".claude.json"), {
    mcpServers: {
      docs: {
        command: "npx",
        args: ["tool", "--token", sensitive],
        env: { API_KEY: sensitive },
        headers: { Authorization: sensitive },
      },
    },
  });
  await put(join(B, ".claude.json"), {
    oauth: sensitive,
    mcpServers: {
      private: { command: "private-tool" },
      docs: { command: "other", args: [], env: { API_KEY: "B own key" } },
    },
  });
  await put(join(A, "skills/team/SKILL.md"), "# Team\nShared skill");
  await put(join(B, "skills/private/SKILL.md"), "# Private");
  await put(join(B, "skills/team/SKILL.md"), "# Old");
  await put(join(A, "plugins/known_marketplaces.json"), {
    team: { source: { repo: "owner/team" } },
  });
  const inv = await ext.inventory(target(a));
  inv.items.forEach((x) => ItemSchema.parse(x));
  assert(!JSON.stringify(inv).includes(sensitive));
  assert(
    !JSON.stringify(await ext.details(target(a), "mcp:docs")).includes(
      sensitive,
    ),
  );
  await ext.common(target(a), ["skill:team", "mcp:docs", "marketplace:team"]);
  const saved = await readFile(
    join(manager.store.root, "extensions/state.json"),
    "utf8",
  );
  assert(!saved.includes(sensitive));
  const plan = await ext.preview([target(b)]);
  assert.equal(plan.steps[0].kind, "marketplace");
  assert.equal(plan.steps.filter((s) => s.action === "conflict").length, 2);
  let j = await finish((await ext.apply(plan.id, [])).job.id);
  assert.equal(j.status, "done");
  assert.equal(
    await readFile(join(B, "skills/team/SKILL.md"), "utf8"),
    "# Old",
  );
  const p2 = await ext.preview([target(b)]);
  j = await finish(
    (
      await ext.apply(
        p2.id,
        p2.steps
          .filter((s) => s.action === "conflict")
          .map((s) => `claude:${b.id}:${s.key}`),
      )
    ).job.id,
  );
  assert.equal(j.status, "done");
  assert.equal(
    await readFile(join(B, "skills/team/SKILL.md"), "utf8"),
    "# Team\nShared skill",
  );
  assert.equal(
    await readFile(join(B, "skills/private/SKILL.md"), "utf8"),
    "# Private",
  );
  const cfg = JSON.parse(await readFile(join(B, ".claude.json"), "utf8"));
  assert.equal(cfg.mcpServers.docs.env.API_KEY, "B own key");
  assert.equal(cfg.mcpServers.docs.args[2], "");
  assert.equal(cfg.mcpServers.private.command, "private-tool");
  assert.equal(cfg.oauth, sensitive);
  assert.equal(
    await readFile(join(B, ".credentials.json"), "utf8"),
    JSON.stringify({ token: "B credential" }),
  );
  const skillIndex = j.steps.findIndex((s) => s.kind === "skill");
  const response = await ext.jobs({
    restore: { id: j.id, index: skillIndex, confirmed: true },
  });
  const restored = await finish(response.jobs.at(-1).id);
  assert.equal(restored.status, "done");
  assert.equal(
    await readFile(join(B, "skills/team/SKILL.md"), "utf8"),
    "# Old",
  );
  const mcpIndex = j.steps.findIndex((s) => s.kind === "mcp");
  const response2 = await ext.jobs({
    restore: { id: j.id, index: mcpIndex, confirmed: true },
  });
  assert.equal((await finish(response2.jobs.at(-1).id)).status, "done");
  assert.equal(
    JSON.parse(await readFile(join(B, ".claude.json"), "utf8")).mcpServers.docs
      .command,
    "other",
  );
  const p3 = await ext.preview([target(b)]);
  await put(join(B, "skills/team/SKILL.md"), "# Concurrent edit");
  await assert.rejects(ext.apply(p3.id, []), /변경/);
  const local = { ...target(b), scope: "local", sessionId: "project" };
  j = await finish(
    (
      await ext.mutate(
        local,
        "mcp",
        "local-server",
        "install",
        JSON.stringify({ command: "local" }),
      )
    ).job.id,
  );
  assert.equal(j.status, "done");
  const localCfg = JSON.parse(await readFile(join(B, ".claude.json"), "utf8"));
  assert.equal(
    localCfg.projects[join(f.root, "project")].mcpServers["local-server"]
      .command,
    "local",
  );
  assert(!localCfg.mcpServers["local-server"]);
  const project = { ...local, scope: "project" };
  j = await finish(
    (
      await ext.mutate(
        project,
        "mcp",
        "project-server",
        "install",
        JSON.stringify({ url: "https://example.test/mcp" }),
      )
    ).job.id,
  );
  assert.equal(j.status, "done");
  assert.equal(
    JSON.parse(await readFile(join(f.root, "project/.mcp.json"), "utf8"))
      .mcpServers["project-server"].type,
    "http",
  );
  assert.equal(
    (await stat(join(manager.store.root, "extensions/state.json"))).mode &
      0o777,
    0o600,
  );
  assert(f.refreshes() > 0);
  await ext.common(target(a), ["mcp:docs"], true);
  assert(
    (await ext.inventory(target(a))).items.some((x) => x.key === "mcp:docs"),
  );
  ext.dispose();
  const reload = new ExtensionManager(manager);
  t.after(() => reload.dispose());
  assert(
    (await reload.inventory(target(a))).common.some(
      (x) => x.key === "skill:team",
    ),
  );
});
test("native command approval, mutation wait, cancel/retry, restarts and path boundaries", async (t) => {
  const f = await fixture(t),
    { ext, manager, a, b, target, finish } = f,
    B = manager.profile(b);
  f.setActive(true);
  let j = (await ext.mutate(target(b), "plugin", "approval@team", "install"))
    .job;
  await delay(50);
  assert.equal(
    (await ext.jobs({})).jobs.find((x) => x.id === j.id).status,
    "waiting",
  );
  await ext.jobs({ cancel: j.id });
  assert.equal((await finish(j.id)).status, "canceled");
  f.setActive(false);
  j = await finish(
    (await ext.mutate(target(b), "plugin", "approval@team", "install")).job.id,
  );
  assert.equal(j.status, "approval");
  assert(j.steps[0].command.includes("echo install safe"));
  await assert.rejects(ext.jobs({ retry: j.id }), /먼저/);
  await assert.rejects(
    ext.jobs({ approve: { id: j.id, hash: "b".repeat(64) } }),
    /변경/,
  );
  await ext.jobs({ approve: { id: j.id, hash: "a".repeat(64) } });
  assert.equal((await finish(j.id)).status, "done");
  assert(
    (await ext.inventory(target(b))).items.some(
      (x) => x.key === "plugin:approval@team",
    ),
  );
  await assert.rejects(
    ext.mutate(target(b), "mcp", "__proto__", "install", "{}"),
    /이름/,
  );
  await put(join(f.root, "outside/SKILL.md"), "# Outside");
  await symlink(join(f.root, "outside"), join(B, "skills"), "dir");
  j = await finish(
    (
      await ext.mutate(
        target(b),
        "skill",
        "escape",
        "install",
        join(f.root, "outside"),
      )
    ).job.id,
  );
  assert.equal(j.status, "error");
  assert.equal(
    await readFile(join(f.root, "outside/SKILL.md"), "utf8"),
    "# Outside",
  );
  await rm(join(B, "skills"));
  await put(join(B, "plugins/installed_plugins.json"), {
    plugins: {
      "foreign@team": [
        { scope: "user", version: "1", installPath: join(f.root, "outside") },
      ],
    },
  });
  assert.equal(
    (await ext.inventory(target(b))).items.find(
      (x) => x.key === "plugin:foreign@team",
    ).editable,
    false,
  );
  await assert.rejects(
    ext.mutate(target(b), "plugin", "foreign@team", "remove"),
    /관리/,
  );
  f.setActive(true);
  j = (
    await ext.mutate(
      target(b),
      "mcp",
      "pending",
      "install",
      '{"command":"pending"}',
    )
  ).job;
  await delay(30);
  ext.dispose();
  const reload = new ExtensionManager(manager);
  t.after(() => reload.dispose());
  assert.equal(
    (await reload.jobs({})).jobs.find((x) => x.id === j.id).status,
    "error",
  );
  await assert.rejects(reload.jobs({ retry: j.id }), /미리보기/);
});
test("Codex TOML writes preserve unrelated fields and isolate secrets", async (t) => {
  const f = await fixture(t),
    { ext, manager, codex, target, finish } = f,
    C = manager.profile(codex);
  await put(
    join(C, "config.toml"),
    'model = "existing-model"\n[mcp_servers.private]\ncommand = "private"\n[mcp_servers.docs]\ncommand = "old"\n[mcp_servers.docs.env]\nTOKEN = "' +
      sensitive +
      '"\n',
  );
  assert(
    !JSON.stringify(await ext.inventory(target(codex))).includes(sensitive),
  );
  let j = await finish(
    (
      await ext.mutate(
        target(codex),
        "mcp",
        "docs",
        "configure",
        '{"command":"new","env":{"TOKEN":""}}',
      )
    ).job.id,
  );
  assert.equal(j.status, "done", JSON.stringify(j));
  const config = await readFile(join(C, "config.toml"), "utf8");
  assert(config.includes("existing-model"));
  assert(config.includes("private"));
  assert(config.includes(sensitive));
  const restored = await ext.jobs({
    restore: { id: j.id, index: 0, confirmed: true },
  });
  assert.equal((await finish(restored.jobs.at(-1).id)).status, "done");
  assert((await readFile(join(C, "config.toml"), "utf8")).includes("old"));
});
test("queued apply rechecks edits and automatic sync only fills missing items", async (t) => {
  const f = await fixture(t),
    { ext, manager, a, b, target, finish } = f,
    A = manager.profile(a),
    B = manager.profile(b);
  await put(join(A, "skills/shared/SKILL.md"), "# Shared");
  await ext.common(target(a), ["skill:shared"], false, false, true);
  f.setActive(true);
  await ext.automatic("claude", b.id, "switch");
  const queued = (await ext.jobs({})).jobs.at(-1);
  await delay(50);
  assert.equal((await ext.jobs({})).jobs.at(-1).status, "waiting");
  await put(join(B, "skills/shared/SKILL.md"), "# Written while queued");
  f.setActive(false);
  await ext.resume();
  assert.equal((await finish(queued.id)).status, "error");
  assert.equal(
    await readFile(join(B, "skills/shared/SKILL.md"), "utf8"),
    "# Written while queued",
  );
  const count = (await ext.jobs({})).jobs.length;
  await ext.automatic("claude", b.id, "switch");
  assert.equal((await ext.jobs({})).jobs.length, count);
  assert.equal(
    await readFile(join(B, "skills/shared/SKILL.md"), "utf8"),
    "# Written while queued",
  );
  await assert.rejects(
    ext
      .mutate(target(b), "mcp", "bad-name", "install", '{"command":3}')
      .then((r) => finish(r.job.id))
      .then((j) => {
        if (j.status === "error") throw Error(j.steps[0].message);
      }),
    /명령/,
  );
});

test("completion waits for provider refresh and restore refuses newer credentials", async (t) => {
  const f = await fixture(t),
    { ext, manager, b, target, finish } = f;
  let release;
  manager.extensionsChanged = () =>
    new Promise((r) => {
      release = r;
    });
  const result = await ext.mutate(
    target(b),
    "mcp",
    "gated",
    "install",
    '{"command":"tool","env":{"TOKEN":"old"}}',
  );
  for (let n = 0; n < 100 && !release; n++) await delay(10);
  assert(release);
  assert.equal(
    (await ext.jobs({})).jobs.find((j) => j.id === result.job.id).status,
    "running",
  );
  release();
  const j = await finish(result.job.id);
  assert.equal(j.status, "done");
  const path = join(manager.profile(b), ".claude.json"),
    cfg = JSON.parse(await readFile(path, "utf8"));
  cfg.mcpServers.gated.env.TOKEN = "new";
  await put(path, cfg);
  manager.extensionsChanged = async () => {};
  const r = await ext.jobs({
    restore: { id: j.id, index: 0, confirmed: true },
  });
  assert.equal((await finish(r.jobs.at(-1).id)).status, "error");
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).mcpServers.gated.env.TOKEN,
    "new",
  );
});

test("inline token flags and URL credentials stay private when sharing MCP configuration", async (t) => {
  const f = await fixture(t),
    { ext, manager, a, b, target, finish } = f;
  const A = manager.profile(a),
    B = manager.profile(b);
  await put(join(A, ".claude.json"), {
    mcpServers: {
      flags: { command: "tool", args: ["--api-key=" + sensitive, "other"] },
      web: { url: "https://example.test/mcp?key=" + sensitive },
    },
  });
  await put(join(B, ".claude.json"), {
    mcpServers: {
      flags: { command: "old", args: ["--api-key=B-private", "other"] },
      web: { url: "https://example.test/mcp?key=B-private" },
    },
  });
  await ext.common(target(a), ["mcp:flags", "mcp:web"]);
  assert(
    !JSON.stringify(await ext.details(target(a), "mcp:flags")).includes(
      sensitive,
    ),
  );
  assert(
    !JSON.stringify(await ext.details(target(a), "mcp:web")).includes(
      sensitive,
    ),
  );
  assert(
    !(await readFile(
      join(manager.store.root, "extensions/state.json"),
      "utf8",
    ).then((s) => s.includes(sensitive))),
  );
  const p = await ext.preview([target(b)]);
  const j = await finish(
    (
      await ext.apply(
        p.id,
        p.steps
          .filter((s) => s.action === "conflict")
          .map((s) => `claude:${b.id}:${s.key}`),
      )
    ).job.id,
  );
  assert.equal(j.status, "done");
  const cfg = JSON.parse(await readFile(join(B, ".claude.json"), "utf8"));
  assert.equal(cfg.mcpServers.flags.args[0], "--api-key=B-private");
  assert.equal(
    new URL(cfg.mcpServers.web.url).searchParams.get("key"),
    "B-private",
  );
});
