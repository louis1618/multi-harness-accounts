import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  utimes,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { System, protectedPids } from "../.test-build/server/system.js";
import { Docker, imageRef } from "../.test-build/server/docker.js";
import { CareManager } from "../.test-build/server/manager.js";
import {
  SettingsSchema,
  RequestSchema,
  JobSchema,
} from "../.test-build/shared/care.js";
import { hash, redact } from "../.test-build/server/util.js";
const settings = () => SettingsSchema.parse({});
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "system-care-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(p, data) {
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, typeof data === "string" ? data : JSON.stringify(data));
}
async function finish(m, id) {
  for (let i = 0; i < 300; i++) {
    const j = (await m.jobs()).jobs.find((j) => j.id === id);
    if (j && !["running", "waiting"].includes(j.status)) {
      JobSchema.parse(j);
      return j;
    }
    await delay(10);
  }
  throw Error("job timeout");
}
const metrics = () => ({
  sampledAt: new Date().toISOString(),
  cpu: 10,
  memory: { total: 1000, available: 400, swapTotal: 500, swapUsed: 400 },
  disks: [
    { device: "test", mount: "/", total: 2000, used: 1000, available: 1000 },
  ],
  programs: [],
});
const fakeSystem = () => ({
  snapshot: async () => metrics(),
  cacheCandidates: async () => [],
  diskAreas: async () => ({
    areas: [{ path: "/", bytes: 1000, status: "measured" }],
    warnings: [],
  }),
  stop: async () => {
    throw Error("unexpected stop");
  },
  cleanThumbnails: async () => {
    throw Error("unexpected cache delete");
  },
});
async function fixture(t) {
  const root = await temporary(t);
  const compose = join(root, "compose.yml");
  await put(compose, "services: {}");
  const calls = [];
  const state = {
    containers: [
      {
        Id: "container-a",
        Names: ["/database"],
        Image: "postgres:1",
        ImageID: "sha256:used",
        State: "exited",
        Status: "Exited",
        Mounts: [{ Type: "volume", Name: "persistent" }],
        NetworkSettings: { Networks: { bridge: {} } },
        Labels: {
          "com.docker.compose.project": "project",
          "com.docker.compose.project.config_files": compose,
        },
      },
    ],
    images: [
      {
        Id: "sha256:used",
        RepoTags: ["postgres:1"],
        RepoDigests: ["postgres@sha256:used"],
        Size: 100,
      },
      {
        Id: "sha256:free",
        RepoTags: ["example/free:1"],
        RepoDigests: ["example/free@sha256:free"],
        Size: 100,
      },
      { Id: "sha256:local", RepoTags: ["local:1"], RepoDigests: [], Size: 100 },
      {
        Id: "sha256:declared",
        RepoTags: ["example/declared:1"],
        RepoDigests: ["example/declared@sha256:declared"],
        Size: 100,
      },
    ],
    networks: [
      {
        Id: "bridge",
        Name: "bridge",
        Driver: "bridge",
        Scope: "local",
        Containers: {},
      },
      {
        Id: "free-net",
        Name: "free-net",
        Driver: "bridge",
        Scope: "local",
        Containers: {},
      },
      {
        Id: "compose-net",
        Name: "project_default",
        Driver: "bridge",
        Scope: "local",
        Containers: {},
      },
    ],
    compose: {
      services: {
        db: { image: "postgres:1" },
        future: {
          image: "example/declared:1",
          environment: { API_KEY: "fixture-secret-do-not-expose" },
        },
      },
      networks: { default: { name: "project_default" } },
    },
    failCompose: false,
  };
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "DELETE") {
      if (path.startsWith("/images/"))
        state.images = state.images.filter((i) => i.Id !== "sha256:free");
      else if (path.startsWith("/networks/"))
        state.networks = state.networks.filter((n) => n.Id !== "free-net");
      else throw Error("forbidden DELETE");
      return null;
    }
    if (method === "POST") {
      assert(path.startsWith("/containers/"));
      return null;
    }
    if (
      path === "/containers/json?all=1&size=1" ||
      path === "/containers/json?all=1"
    )
      return state.containers;
    if (path === "/images/json?all=1") return state.images;
    if (path === "/volumes")
      return {
        Volumes: [
          { Name: "persistent", Driver: "local" },
          { Name: "detached-data", Driver: "local" },
        ],
      };
    if (path === "/networks") return state.networks;
    if (path === "/system/df")
      return {
        LayersSize: 250,
        Images: state.images.map((i) => ({
          ...i,
          Containers: i.Id === "sha256:used" ? 1 : 0,
          SharedSize: 50,
        })),
        Volumes: [
          { Name: "persistent", UsageData: { Size: 50 } },
          { Name: "detached-data", UsageData: { Size: -1 } },
        ],
        Containers: [],
        BuildCache: [],
      };
    if (path === "/containers/container-a/json")
      return {
        Config: { Env: ["API_KEY=fixture-secret-do-not-expose"], Tty: true },
      };
    if (path.includes("/logs?"))
      return Buffer.from(
        "API_KEY=fixture-secret-do-not-expose\nBearer abcdefghijklmnopqrst\nfixture-secret-do-not-expose",
      );
    throw Error("unexpected API: " + path);
  };
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("config"))
      return {
        stdout: JSON.stringify(state.compose),
        stderr: "",
        code: state.failCompose ? 1 : 0,
      };
    return { stdout: "", stderr: "", code: 0 };
  };
  return { root, state, run, api, calls };
}
test("Docker inventory protects stopped containers, local images, Compose and persistent data", async (t) => {
  const f = await fixture(t),
    docker = new Docker(f.run, f.api),
    d = await docker.snapshot(settings());
  assert(d.available);
  assert.equal(d.images.find((i) => i.id === "sha256:used").protected, true);
  assert.equal(
    d.images.find((i) => i.id === "sha256:declared").protected,
    true,
  );
  assert.equal(d.images.find((i) => i.id === "sha256:local").protected, true);
  assert.equal(d.images.find((i) => i.id === "sha256:free").protected, false);
  assert.equal(d.networks.find((n) => n.id === "compose-net").protected, true);
  assert.equal(d.volumes.find((v) => v.name === "detached-data").bytes, null);
  assert.equal(d.usage.imageBytes, 250);
  assert(!JSON.stringify(d).includes("fixture-secret"));
  assert.equal(imageRef("redis:1"), "docker.io/library/redis:1");
  assert.equal(imageRef("ghcr.io/x/a@sha256:abc"), "ghcr.io/x/a@sha256:abc");
  const log = await docker.logs("container-a", 100);
  assert(!log.text.includes("fixture-secret"));
  assert(!log.text.includes("abcdefghijklmnopqrst"));
  assert(log.text.includes("[숨김]"));
  assert(f.calls.every((c) => !c.method || c.method === "GET"));
});
test("explicit image/network removal never calls volume/container delete or forced prune", async (t) => {
  const f = await fixture(t),
    docker = new Docker(f.run, f.api),
    d = await docker.snapshot(settings());
  const i = d.images.find((i) => i.id === "sha256:free"),
    n = d.networks.find((n) => n.id === "free-net");
  await docker.change(
    { action: "image-remove", target: i.id },
    settings(),
    i.fingerprint,
    d.identity,
  );
  await docker.change(
    { action: "network-remove", target: n.id },
    settings(),
    n.fingerprint,
    d.identity,
  );
  const deleted = f.calls.filter((c) => c.method === "DELETE");
  assert.equal(deleted.length, 2);
  assert(deleted[0].path.includes("force=0&noprune=1"));
  assert(
    deleted.every(
      (c) => !c.path.includes("/volumes") && !c.path.includes("/containers"),
    ),
  );
  assert(!f.calls.some((c) => c.args?.join(" ").includes("system prune")));
  await assert.rejects(
    docker.change(
      { action: "image-remove", target: "sha256:used" },
      settings(),
      "x",
      d.identity,
    ),
    /参照|참조|건너/,
  );
});
test("Compose failures and new references invalidate removal and leave objects intact", async (t) => {
  const f = await fixture(t),
    docker = new Docker(f.run, f.api);
  let d = await docker.snapshot(settings());
  const old = d.images.find((i) => i.id === "sha256:free");
  f.state.containers.push({
    ...f.state.containers[0],
    Id: "new-container",
    Names: ["/new"],
    ImageID: old.id,
  });
  await assert.rejects(
    docker.change(
      { action: "image-remove", target: old.id },
      settings(),
      old.fingerprint,
      d.identity,
    ),
    /변경/,
  );
  assert(!f.calls.some((c) => c.method === "DELETE"));
  f.state.failCompose = true;
  d = await docker.snapshot(settings(), true);
  assert(!d.composeComplete);
  assert(d.images.every((i) => i.protected));
  assert(d.networks.every((n) => n.protected));
});
test("preview binds approved objects, skips changed targets, forbids deletes and persists interrupted jobs", async (t) => {
  const f = await fixture(t),
    m = new CareManager({
      root: join(f.root, "store"),
      run: f.run,
      system: fakeSystem(),
      dockerApi: f.api,
    });
  t.after(() => m.dispose());
  const p = await m.preview([
    { action: "image-remove", target: "sha256:free" },
    { action: "image-remove", target: "sha256:used" },
  ]);
  assert.equal(p.steps.length, 1);
  assert.equal(p.excluded.length, 1);
  f.state.containers.push({
    ...f.state.containers[0],
    Id: "new",
    Names: ["/new"],
    ImageID: "sha256:free",
  });
  const j = await finish(m, (await m.execute(p.id)).id);
  assert.equal(j.steps[0].status, "skipped");
  assert(!f.calls.some((c) => c.method === "DELETE"));
  await assert.rejects(m.execute(p.id), /만료/);
  assert(
    !RequestSchema.safeParse({ action: "volume-remove", target: "persistent" })
      .success,
  );
  assert(
    !RequestSchema.safeParse({
      action: "container-remove",
      target: "container-a",
    }).success,
  );
  const ledger = JSON.parse(
    await readFile(join(f.root, "store/state.json"), "utf8"),
  );
  ledger.jobs[0].status = "running";
  ledger.jobs[0].steps[0].status = "running";
  await put(join(f.root, "store/state.json"), ledger);
  m.dispose();
  const restored = new CareManager({
    root: join(f.root, "store"),
    run: f.run,
    system: fakeSystem(),
    dockerApi: f.api,
  });
  t.after(() => restored.dispose());
  assert.equal((await restored.jobs()).jobs[0].status, "interrupted");
  assert.equal(
    (await lstat(join(f.root, "store/state.json"))).mode & 0o777,
    0o600,
  );
});
test("only whitelisted old thumbnails are removed; open files and links fail closed", async (t) => {
  const root = await temporary(t),
    home = join(root, "home"),
    base = join(home, ".cache/thumbnails/normal"),
    old = join(base, "old.png"),
    recent = join(base, "recent.png"),
    personal = join(home, "Documents/old.png");
  await put(old, "old preview");
  await put(recent, "recent preview");
  await put(personal, "personal file");
  await utimes(old, new Date(0), new Date(0));
  let open = true;
  const run = async () => ({
    code: open ? 0 : 1,
    stdout: open ? "123" : "",
    stderr: "",
  });
  const system = new System(run, "/proc", home);
  const before = await system.thumbnailFiles();
  assert.equal(before.files.length, 1);
  await assert.rejects(system.cleanThumbnails(before.fingerprint), /열린/);
  assert.equal(await readFile(old, "utf8"), "old preview");
  open = false;
  await system.cleanThumbnails(before.fingerprint);
  assert.equal(await readFile(recent, "utf8"), "recent preview");
  assert.equal(await readFile(personal, "utf8"), "personal file");
  await symlink(
    join(home, "Documents"),
    join(home, ".cache/thumbnails/linked"),
  );
  const next = await system.thumbnailFiles();
  assert(next.unreadable);
  assert.equal((await system.cacheCandidates())[0].eligible, false);
});
test("PID reuse and core/agent/container process trees are protected", async (t) => {
  const root = await temporary(t),
    proc = join(root, "proc"),
    uid = process.getuid();
  const rows = [
    {
      pid: 100,
      ppid: 1,
      uid,
      name: "gnome-shell",
      ticks: 0,
      start: "1",
      rss: 1,
      age: 1,
      service: null,
      container: null,
      protect: false,
    },
    {
      pid: 200,
      ppid: 100,
      uid,
      name: "ordinary",
      ticks: 0,
      start: "10",
      rss: 1,
      age: 1,
      service: null,
      container: null,
      protect: false,
    },
    {
      pid: 300,
      ppid: 1,
      uid,
      name: "codex",
      ticks: 0,
      start: "1",
      rss: 1,
      age: 1,
      service: null,
      container: null,
      protect: false,
    },
    {
      pid: 301,
      ppid: 300,
      uid,
      name: "node",
      ticks: 0,
      start: "1",
      rss: 1,
      age: 1,
      service: null,
      container: null,
      protect: false,
    },
  ];
  const protectedSet = protectedPids(rows);
  assert(protectedSet.has(100));
  assert(protectedSet.has(300));
  assert(protectedSet.has(301));
  assert(!protectedSet.has(200));
  await put(join(proc, "uptime"), "1000 0");
  await put(join(proc, "stat"), "cpu 100 0 100 800 0 0 0 0\n");
  await put(
    join(proc, "meminfo"),
    "MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 100 kB\nSwapFree: 10 kB\n",
  );
  let start = "10";
  async function fakeProc() {
    const fields = [
      "S",
      "1",
      ...Array(9).fill("0"),
      "1",
      "1",
      ...Array(6).fill("0"),
      start,
      ...Array(4).fill("0"),
    ];
    await put(join(proc, "200/stat"), "200 (ordinary) " + fields.join(" "));
    await put(
      join(proc, "200/status"),
      `Uid:\t${uid}\t${uid}\nVmRSS:\t10 kB\n`,
    );
    await put(join(proc, "200/cgroup"), "0::/user.slice/example.scope");
  }
  await fakeProc();
  const sent = [];
  const system = new System(
    async () => ({ stdout: "100", stderr: "", code: 0 }),
    proc,
    root,
    uid,
    (pid) => sent.push(pid),
  );
  const program = (await system.snapshot(settings())).programs[0];
  assert(!program.protected);
  start = "20";
  await fakeProc();
  await assert.rejects(system.stop(program, settings()), /변경/);
  assert.equal(sent.length, 0);
  const fresh = (await system.snapshot(settings(), true)).programs[0];
  await system.stop(fresh, settings());
  assert.deepEqual(sent, [200]);
});
test("admin cancellation and unsupported operations cannot trigger arbitrary maintenance", async (t) => {
  const root = await temporary(t),
    calls = [],
    s = fakeSystem();
  s.cacheCandidates = async () => [
    {
      id: "system:apt-autoclean",
      action: "apt-autoclean",
      title: "APT",
      bytes: 10,
      eligible: true,
      reason: "test",
      impact: "test",
      admin: true,
      fingerprint: "fixed",
    },
  ];
  const m = new CareManager({
    root,
    system: s,
    run: async (c, args) => {
      calls.push({ c, args });
      return { code: 126, stdout: "", stderr: "private raw output" };
    },
  });
  m.helper = async () => ({ installed: true, message: "fixture" });
  t.after(() => m.dispose());
  const p = await m.preview([
    { action: "apt-autoclean", target: "system:apt-autoclean" },
  ]);
  const j = await finish(m, (await m.execute(p.id)).id);
  assert.equal(j.status, "error");
  assert(j.steps[0].message.includes("승인"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].c, "/usr/bin/pkexec");
  assert.equal(calls[0].args.at(-1), "apt-autoclean");
  assert(!JSON.stringify(j).includes("private raw output"));
  const bad = await m.preview([
    { action: "apt-autoclean", target: "/etc/passwd" },
  ]);
  assert.equal(bad.steps.length, 0);
  assert.equal(bad.excluded.length, 1);
});
test("redaction handles known secrets, bearer tokens and credential assignments", () => {
  const raw =
    'token=abc password="xyz" Bearer 123456789 API_KEY=secret-123 ' +
    "private-literal";
  const out = redact(raw, ["private-literal"]);
  assert(!out.includes("abc"));
  assert(!out.includes("xyz"));
  assert(!out.includes("secret-123"));
  assert(!out.includes("private-literal"));
});
test("missing Compose files fail closed even if the working directory has a valid configuration", async (t) => {
  const f = await fixture(t);
  delete f.state.containers[0].Labels[
    "com.docker.compose.project.config_files"
  ];
  const d = await new Docker(f.run, f.api).snapshot(settings());
  assert(d.available);
  assert(!d.composeComplete);
  assert(d.images.every((i) => i.protected));
  assert(d.networks.every((n) => n.protected));
  assert(!f.calls.some((c) => c.args?.includes("config")));
});
test("jobs run serially and cancellation leaves remaining resources intact", async (t) => {
  const f = await fixture(t);
  let unblock;
  const gate = new Promise((r) => (unblock = r));
  let started;
  const entered = new Promise((r) => (started = r));
  const api = async (method, path, body) => {
    if (method === "DELETE" && path.startsWith("/images/")) {
      started();
      await gate;
    }
    return f.api(method, path, body);
  };
  const m = new CareManager({
    root: join(f.root, "queue"),
    run: f.run,
    system: fakeSystem(),
    dockerApi: api,
  });
  t.after(() => m.dispose());
  const p = await m.preview([
    { action: "image-remove", target: "sha256:free" },
    { action: "network-remove", target: "free-net" },
  ]);
  const second = await m.preview([
    { action: "network-remove", target: "free-net" },
  ]);
  const j1 = await m.execute(p.id);
  await entered;
  const j2 = await m.execute(second.id);
  assert.equal(j2.status, "waiting");
  assert(!f.calls.some((c) => c.method === "DELETE"));
  await m.jobs(j1.id);
  await m.jobs(j2.id);
  unblock();
  const done = await finish(m, j1.id);
  assert.equal(done.status, "canceled");
  assert.equal(done.steps[0].status, "done");
  assert.equal(done.steps[1].status, "canceled");
  assert.equal((await finish(m, j2.id)).status, "canceled");
  assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 1);
  assert(f.state.networks.some((n) => n.Id === "free-net"));
});
test("partial failure is recorded without repeating successful steps", async (t) => {
  const f = await fixture(t);
  const api = async (method, path, body) => {
    if (method === "DELETE" && path.startsWith("/networks/"))
      throw Error("private daemon error");
    return f.api(method, path, body);
  };
  const m = new CareManager({
    root: join(f.root, "partial"),
    run: f.run,
    system: fakeSystem(),
    dockerApi: api,
  });
  t.after(() => m.dispose());
  const p = await m.preview([
    { action: "image-remove", target: "sha256:free" },
    { action: "network-remove", target: "free-net" },
  ]);
  const j = await finish(m, (await m.execute(p.id)).id);
  assert.equal(j.status, "partial");
  assert.deepEqual(
    j.steps.map((s) => s.status),
    ["done", "error"],
  );
  assert(!JSON.stringify(j).includes("private daemon error"));
  assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 1);
  assert(f.state.networks.some((n) => n.Id === "free-net"));
});
test("expired previews cannot run, and an execution metrics failure terminates the job", async (t) => {
  const f = await fixture(t),
    s = fakeSystem(),
    m = new CareManager({
      root: join(f.root, "expiry"),
      run: f.run,
      system: s,
      dockerApi: f.api,
    });
  t.after(() => m.dispose());
  const p = await m.preview([
    { action: "image-remove", target: "sha256:free" },
  ]);
  m.previews.get(p.id).expires = 0;
  await assert.rejects(m.execute(p.id), /만료/);
  const p2 = await m.preview([
    { action: "image-remove", target: "sha256:free" },
  ]);
  s.snapshot = async () => {
    throw Error("private metrics failure");
  };
  const j = await finish(m, (await m.execute(p2.id)).id);
  assert.equal(j.status, "error");
  assert(!JSON.stringify(j).includes("private metrics"));
  assert(!f.calls.some((c) => c.method === "DELETE"));
});
test("filesystem analysis excludes same-device bind mounts and reports permission failures", async (t) => {
  const root = await temporary(t),
    proc = join(root, "proc");
  await put(
    join(proc, "self/mountinfo"),
    "1 0 8:1 / / rw - ext4 /dev/test rw\n2 1 8:1 /private /mnt/private rw - ext4 /dev/test rw\n3 1 8:1 /private /mnt/with\\040space rw - ext4 /dev/test rw\n",
  );
  const calls = [];
  const s = new System(
    async (command, args) => {
      calls.push({ command, args });
      return { code: 1, stdout: "100\t/home\0", stderr: "permission denied" };
    },
    proc,
    root,
  );
  const d = await s.diskAreas(new AbortController().signal);
  assert(calls[0].args.includes("--exclude=/mnt/private"));
  assert(calls[0].args.includes("--exclude=/mnt/with space"));
  assert(calls[0].args.includes("--one-file-system"));
  assert.equal(d.areas.find((a) => a.path === "/home").status, "partial");
  assert.equal(d.areas.find((a) => a.path === "/root").status, "unavailable");
  assert(d.warnings.length);
});
test("secret values with spaces and short passwords are hidden before patterns and size trimming", async (t) => {
  assert.equal(
    redact("PASSWORD=small words", ["small words"]),
    "PASSWORD=[숨김]",
  );
  assert.equal(redact("pass 123", ["123"]), "pass [숨김]");
  const f = await fixture(t);
  const secret = "a".repeat(10000) + "secret-tail";
  const api = async (method, path, body) =>
    path === "/containers/container-a/json"
      ? { Config: { Env: ["PASSWORD=" + secret], Tty: true } }
      : path.includes("/logs?")
        ? Buffer.from("padding".repeat(10000) + secret + "\nend")
        : f.api(method, path, body);
  const docker = new Docker(f.run, api);
  await docker.snapshot(settings());
  const out = await docker.logs("container-a", 100);
  assert(out.truncated);
  assert(!out.text.includes("secret-tail"));
  assert(Buffer.byteLength(out.text) <= 65536);
  assert(out.text.includes("[숨김]"));
});
test("automatic analysis can be canceled and never registers cleanup jobs", async (t) => {
  const f = await fixture(t),
    s = fakeSystem();
  let started;
  const began = new Promise((r) => (started = r));
  s.diskAreas = async (signal) => {
    started();
    await new Promise((r) =>
      signal.addEventListener("abort", r, { once: true }),
    );
    throw Error("analysis canceled");
  };
  const m = new CareManager({
    root: join(f.root, "analysis"),
    run: f.run,
    system: s,
    dockerApi: f.api,
  });
  t.after(() => m.dispose());
  assert.equal((await m.scan()).status, "running");
  await began;
  await m.scan(true);
  for (
    let i = 0;
    i < 20 && (await m.snapshot()).analysis.status === "running";
    i++
  )
    await delay(10);
  assert.equal((await m.snapshot()).analysis.status, "canceled");
  assert.equal((await m.jobs()).jobs.length, 0);
  assert(!f.calls.some((c) => c.method === "DELETE" || c.method === "POST"));
});
test("protected containers and unknown builders cannot be changed", async (t) => {
  const f = await fixture(t),
    cfg = settings();
  cfg.protectedContainers = ["database"];
  const docker = new Docker(f.run, f.api),
    d = await docker.snapshot(cfg);
  await assert.rejects(
    docker.change(
      { action: "container-stop", target: "container-a" },
      cfg,
      d.containers[0].fingerprint,
      d.identity,
    ),
    /보호/,
  );
  await assert.rejects(
    docker.change(
      { action: "build-cache", target: "default" },
      cfg,
      hash([d.identity, d.usage.buildBytes]),
      d.identity,
    ),
    /builder|로컬/,
  );
  assert(
    !f.calls.some(
      (c) =>
        c.method === "POST" ||
        c.method === "DELETE" ||
        c.args?.includes("prune"),
    ),
  );
});

test("automatic cleanup selects eligible cache and Docker objects without executing or selecting programs", async (t) => {
  const f = await fixture(t),
    s = fakeSystem();
  s.cacheCandidates = async () => [
    {
      id: "cache:thumbnails",
      action: "thumbnails",
      title: "old thumbnails",
      bytes: 100,
      eligible: true,
      reason: "old",
      impact: "recreated",
      admin: false,
      fingerprint: "thumb",
    },
    {
      id: "cache:protected",
      action: "thumbnails",
      title: "protected",
      bytes: 100,
      eligible: false,
      reason: "protected",
      impact: "",
      admin: false,
      fingerprint: "protected",
    },
    {
      id: "program:ordinary",
      action: "process-stop",
      title: "program",
      bytes: null,
      eligible: true,
      reason: "user program",
      impact: "unsaved work",
      admin: false,
      fingerprint: "pid",
    },
  ];
  const m = new CareManager({
    root: join(f.root, "automatic"),
    system: s,
    run: f.run,
    dockerApi: f.api,
  });
  t.after(() => m.dispose());
  const plan = await m.autoPreview();
  assert.deepEqual(plan.steps.map((s) => s.request.action).sort(), [
    "image-remove",
    "network-remove",
    "thumbnails",
  ]);
  assert.equal((await m.jobs()).jobs.length, 0);
  assert(!f.calls.some((c) => c.method === "POST" || c.method === "DELETE"));
  assert(
    !plan.steps.some(
      (s) => s.request.action === "process-stop" || s.title === "database",
    ),
  );
});

test("automatic cleanup protects unknown references and skips privileged work when its helper is absent", async (t) => {
  const f = await fixture(t),
    s = fakeSystem();
  f.state.failCompose = true;
  s.cacheCandidates = async () => [
    {
      id: "system:apt-autoclean",
      action: "apt-autoclean",
      title: "APT",
      bytes: 100,
      eligible: true,
      reason: "obsolete",
      impact: "download again",
      admin: true,
      fingerprint: "apt",
    },
  ];
  const m = new CareManager({
    root: join(f.root, "automatic-protected"),
    system: s,
    run: f.run,
    dockerApi: f.api,
  });
  m.helper = async () => ({ installed: false, message: "not installed" });
  t.after(() => m.dispose());
  const plan = await m.autoPreview();
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.excluded.length, 1);
  assert(
    !f.calls.some(
      (c) =>
        c.method === "POST" ||
        c.method === "DELETE" ||
        c.c === "/usr/bin/pkexec",
    ),
  );
});
