import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  readdir,
  lstat,
  realpath,
  rm,
  mkdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parse, stringify } from "smol-toml";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  TargetSchema,
  JobSchema,
  ItemSchema,
  type Target,
  type Kind,
  type ExtensionItem,
  type ExtensionJob,
} from "../shared/extensions.js";
import { AccountError, atomicWrite, privateDirectory } from "./store.js";
import { defaultBrowser } from "./adapters.js";
import { selectedAccount, agentsOn, type AccountManager } from "./manager.js";
const run = promisify(execFile),
  digest = (x: unknown) =>
    createHash("sha256").update(JSON.stringify(x)).digest("hex");
type RecordItem = {
  view: ExtensionItem;
  spec: any;
  path?: string;
  expected?: string;
};
type Step = ExtensionJob["steps"][number];
interface Stored {
  version: 1;
  common: Record<string, RecordItem[]>;
  autoNew: boolean;
  autoSwitch: boolean;
  jobs: ExtensionJob[];
}
function sourceSafe(s: string) {
  if (typeof s !== "string" || !s.trim())
    throw new AccountError("설치 소스를 입력하세요.");
  if (s.length > 4096 || /[\0\r\n]/.test(s) || s.startsWith("-"))
    throw new AccountError("설치 소스가 올바르지 않습니다.");
  if (/^[a-z]+:\/\//i.test(s)) {
    const u = new URL(s);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      throw new AccountError(
        "인증 정보가 없는 HTTPS 저장소 주소를 사용하세요.",
      );
  }
  return s;
}
function publicUrl(s: unknown) {
  if (typeof s !== "string") return null;
  try {
    const u = new URL(s);
    return u.origin + u.pathname;
  } catch {
    return /^[\w./@:+-]{1,512}$/.test(s) ? s : null;
  }
}
const secret =
  /token|password|secret|authorization|api.?key|cookie|credential|^(?:key|auth|code|signature|sig)$/i;
function clean(x: any, key = ""): any {
  if (secret.test(key)) return "";
  if (Array.isArray(x)) {
    let hide = false;
    return x.map((v) => {
      const previous = hide;
      hide = typeof v === "string" && !v.includes("=") && secret.test(v);
      return previous ? "" : clean(v);
    });
  }
  if (x && typeof x === "object") {
    return Object.fromEntries(
      Object.entries(x).map(([k, v]) => [
        k,
        ["env", "headers", "http_headers"].includes(k)
          ? Object.fromEntries(
              Object.keys((v as object) ?? {}).map((n) => [n, ""]),
            )
          : clean(v, k),
      ]),
    );
  }
  if (
    typeof x === "string" &&
    /^(?:Bearer\s+|sk-(?:ant-|proj-)?[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9_]{16,}|eyJ[a-zA-Z0-9_-]+\.eyJ)/.test(
      x,
    )
  )
    return "";
  if (typeof x === "string") {
    const flag = x.match(/^(-{1,2}[^=\s]+)=/);
    if (flag && secret.test(flag[1].replace(/^-+/, ""))) return flag[1] + "=";
    if (
      !/^https?:\/\//.test(x) &&
      /(?:Bearer\s+|[A-Z_]*(?:TOKEN|PASSWORD|SECRET|KEY)=)[^\s]+/i.test(x)
    )
      return "";
  }
  if (typeof x === "string" && /https?:\/\//.test(x)) {
    try {
      const u = new URL(x);
      u.username = "";
      u.password = "";
      for (const k of [...u.searchParams.keys()])
        if (secret.test(k)) u.searchParams.set(k, "");
      return u.href;
    } catch {
      return "";
    }
  }
  return x;
}
function needsAuth(x: any): boolean {
  if (x === "") return true;
  if (typeof x === "string") {
    if (/^--?[^=]+=$/.test(x) && secret.test(x.replace(/^-+|=$/g, "")))
      return true;
    try {
      const u = new URL(x);
      return [...u.searchParams].some(([k, v]) => secret.test(k) && v === "");
    } catch {
      return false;
    }
  }
  return Boolean(
    x &&
      typeof x === "object" &&
      Object.entries(x).some(
        ([k, v]) =>
          (["env", "headers", "http_headers"].includes(k) &&
            v &&
            Object.values(v as object).some((v) => v === "")) ||
          needsAuth(v),
      ),
  );
}
function mergePrivate(current: any, next: any): any {
  if (Array.isArray(next))
    return next.map((v, i) =>
      v === "" && Array.isArray(current) && next[i - 1] === current[i - 1]
        ? (current[i] ?? "")
        : mergePrivate(current?.[i], v),
    );
  if (next && typeof next === "object" && !Array.isArray(next))
    return {
      ...current,
      ...Object.fromEntries(
        Object.entries(next).map(([k, v]) => [
          k,
          mergePrivate(current?.[k], v),
        ]),
      ),
    };
  if (typeof next === "string" && typeof current === "string") {
    const flag = next.match(/^(-{1,2}[^=\s]+)=$/);
    if (flag && current.startsWith(flag[1] + "=")) return current;
    if (/^https?:/.test(next))
      try {
        const n = new URL(next),
          c = new URL(current);
        if (n.origin === c.origin && n.pathname === c.pathname)
          for (const [k, v] of n.searchParams)
            if (v === "" && secret.test(k) && c.searchParams.has(k))
              n.searchParams.set(k, c.searchParams.get(k)!);
        return n.href;
      } catch {}
  }
  return next === "" && current !== undefined ? current : next;
}
async function json(path: string, fallback: any = {}, max = 2 * 1024 * 1024) {
  try {
    return JSON.parse(await text(path, max));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new AccountError("설정 파일을 읽지 못했습니다. 원본을 확인하세요.");
  }
}
async function text(path: string, max = 2 * 1024 * 1024) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size > max)
    throw new AccountError("설정 파일 형식 또는 크기가 올바르지 않습니다.");
  return readFile(path, "utf8");
}
async function exists(p: string) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}
async function skillFiles(root: string) {
  const result: { rel: string; data: Buffer }[] = [];
  let bytes = 0;
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (
        e.name === "node_modules" ||
        e.name === ".git" ||
        /^\.env|credentials|^auth\.json$/i.test(e.name)
      )
        continue;
      const p = join(dir, e.name),
        s = await lstat(p);
      if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory()))
        throw new AccountError("스킬에 외부 링크 또는 특수 파일이 있습니다.");
      if (s.isDirectory()) await walk(p);
      else {
        bytes += s.size;
        if (result.length >= 500 || bytes > 20 * 1024 * 1024)
          throw new AccountError(
            "스킬은 500개 파일·20MB까지 가져올 수 있습니다.",
          );
        result.push({ rel: relative(root, p), data: await readFile(p) });
      }
    }
  }
  await walk(root);
  return result.sort((a, b) => a.rel.localeCompare(b.rel));
}

function inside(root: string, path: string) {
  const rel = relative(resolve(root), resolve(path));
  return (
    rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")
  );
}
async function safeParents(path: string, root: string) {
  if (!inside(root, path))
    throw new AccountError("대상 폴더 밖의 파일은 변경할 수 없습니다.");
  const parts = relative(resolve(root), resolve(path)).split("/");
  let at = resolve(root);
  for (const part of parts) {
    at = join(at, part);
    try {
      if ((await lstat(at)).isSymbolicLink())
        throw new AccountError("외부 링크가 포함된 경로는 변경할 수 없습니다.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
function validateMcp(spec: any, harness: string) {
  const forbidden = (x: any): boolean =>
    Boolean(
      x &&
        typeof x === "object" &&
        Object.entries(x).some(
          ([k, v]) =>
            ["__proto__", "constructor", "prototype"].includes(k) ||
            forbidden(v),
        ),
    );
  if (forbidden(spec))
    throw new AccountError("MCP 설정 키가 올바르지 않습니다.");
  for (const key of ["env", "headers", "http_headers"])
    if (
      spec?.[key] &&
      (typeof spec[key] !== "object" ||
        Array.isArray(spec[key]) ||
        Object.values(spec[key]).some((v) => typeof v !== "string"))
    )
      throw new AccountError("환경 변수와 헤더는 문자열 값의 객체여야 합니다.");
  if (
    !spec ||
    typeof spec !== "object" ||
    Array.isArray(spec) ||
    Object.keys(spec).some((k) =>
      ["__proto__", "constructor", "prototype"].includes(k),
    )
  )
    throw new AccountError("MCP 설정은 객체여야 합니다.");
  if (
    (spec.command && typeof spec.command !== "string") ||
    (spec.args && !Array.isArray(spec.args)) ||
    spec.args?.some((s: any) => typeof s !== "string")
  )
    throw new AccountError("MCP 명령과 인수를 확인하세요.");
  if (spec.url) {
    let u;
    try {
      u = new URL(spec.url);
    } catch {
      throw new AccountError("MCP 서버 주소를 확인하세요.");
    }
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
      throw new AccountError(
        "MCP는 인증 정보가 없는 HTTP(S) 주소를 사용하세요.",
      );
    if (harness === "claude") spec.type ??= "http";
  }
  if (spec.env && Object.values(spec.env).some((v) => typeof v !== "string"))
    throw new AccountError("환경 변수 값은 문자열이어야 합니다.");
}
async function components(root: string) {
  const result: string[] = [];
  if (!inside(homedir(), resolve(root))) return result;
  for (const [folder, label] of [
    ["skills", "스킬"],
    ["agents", "에이전트"],
    ["commands", "명령"],
  ] as const) {
    const p = join(root, folder);
    if (!(await exists(p))) continue;
    const st = await lstat(p);
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    for (const e of (await readdir(p, { withFileTypes: true })).slice(0, 200))
      if (!e.isSymbolicLink() && !e.name.startsWith("."))
        result.push(`${label}: ${e.name.replace(/\.md$/, "")}`);
  }
  if (await exists(join(root, "hooks/hooks.json"))) result.push("훅 설정");
  if (await exists(join(root, ".mcp.json"))) {
    const m = await json(join(root, ".mcp.json"));
    for (const name of Object.keys(m.mcpServers ?? m).slice(0, 100))
      result.push(`MCP: ${name}`);
  }
  return result;
}
export class ExtensionManager {
  private root: string;
  private state: Stored = {
    version: 1,
    common: {},
    autoNew: false,
    autoSwitch: false,
    jobs: [],
  };
  private ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private plans = new Map<
    string,
    { expires: number; steps: Step[]; specs: RecordItem[]; baseline: string[] }
  >();
  private payloads = new Map<string, RecordItem[]>();
  private locks = new Set<string>();
  private children = new Set<ChildProcess>();
  private driving = new Set<string>();
  private timer: ReturnType<typeof setInterval>;
  private disposed = false;
  constructor(
    readonly manager: AccountManager,
    private commands: Record<string, string> = {
      codex: "codex",
      claude: "claude",
    },
  ) {
    this.root = join(manager.store.root, "extensions");
    this.ready = this.load();
    this.timer = setInterval(() => {
      void this.resume().catch(() => {});
    }, 4000);
    this.timer.unref();
  }
  private async load() {
    await privateDirectory(this.root);
    this.state = await json(join(this.root, "state.json"), this.state);
    if (
      this.state.version !== 1 ||
      !this.state.common ||
      !Array.isArray(this.state.jobs)
    )
      throw new AccountError("확장 관리 저장 파일을 확인하세요.");
    for (const [harness, rows] of Object.entries(this.state.common)) {
      if (!["codex", "claude"].includes(harness) || !Array.isArray(rows))
        throw new AccountError("공통 구성을 확인하세요.");
      for (const r of rows) {
        ItemSchema.parse(r.view);
        if (
          r.view.kind === "skill" &&
          (!r.path || !inside(join(this.root, "skills"), r.path))
        )
          throw new AccountError("공통 스킬 경로를 확인하세요.");
        r.spec = clean(r.spec);
      }
    }
    this.state.jobs = this.state.jobs.map((j) => {
      j = JobSchema.parse(j);
      if (!["done", "error", "canceled"].includes(j.status)) {
        j.status = "error";
        for (const s of j.steps)
          if (!["done", "skipped"].includes(s.status)) {
            s.status = "error";
            s.message =
              "데몬이 재시작되었습니다. 적용 결과를 새로 확인한 뒤 재시도하세요.";
          }
      }
      return j;
    });
    await this.save();
  }
  private async save() {
    await atomicWrite(
      join(this.root, "state.json"),
      JSON.stringify(this.state, null, 2),
    );
  }
  private serial<T>(f: () => Promise<T>) {
    const r = this.queue.then(f);
    this.queue = r.catch(() => {});
    return r;
  }
  private key(t: Target) {
    return `${t.harness}:${t.accountId ?? "system"}`;
  }
  private async context(t: Target) {
    TargetSchema.parse(t);
    const state = await this.manager.store.read();
    const a = t.accountId
      ? state.accounts.find((a) => a.id === t.accountId)
      : null;
    if (t.accountId && (!a || a.harness !== t.harness))
      throw new AccountError("대상 계정을 찾지 못했습니다.");
    const home = a
      ? this.manager.profile(a)
      : this.manager.adapters[t.harness].systemHome;
    let cwd = home;
    if (t.scope !== "user") {
      if (!t.sessionId) throw new AccountError("프로젝트 세션을 선택하세요.");
      const s = (await this.manager.sessions(this.paseo!, false)).sessions.find(
        (s) => s.id === t.sessionId && s.harness === t.harness,
      );
      if (!s) throw new AccountError("프로젝트 세션을 찾지 못했습니다.");
      cwd = await realpath(s.cwd);
    }
    const env = t.accountId
      ? {
          ...process.env,
          ...this.manager.adapters[t.harness].environment(home),
        }
      : { ...process.env };
    if (t.accountId)
      env[t.harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = home;
    return { home, cwd, env };
  }
  private paseo?: PluginHandlerContext["paseo"];
  setPaseo(p: PluginHandlerContext["paseo"]) {
    this.paseo = p;
  }
  private async cli(t: Target, args: string[], approved?: string) {
    const c = await this.context(t);
    try {
      const pending = run(
        this.commands[t.harness],
        approved ? [...args, "--accept-command", approved] : args,
        {
          env: c.env,
          cwd: c.cwd,
          timeout: args.includes("list") ? 15000 : 120000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      this.children.add(pending.child);
      try {
        const out = (await pending).stdout.trim();
        try {
          return JSON.parse(out || "null");
        } catch {
          return null;
        }
      } finally {
        this.children.delete(pending.child);
      }
    } catch (e) {
      let value: any;
      try {
        value = JSON.parse(String((e as any).stdout));
      } catch {}
      if (value?.shownCommand?.sha256) {
        const error = new AccountError(
          "설치 소스가 명령 실행 승인을 요청했습니다.",
        ) as any;
        error.approvalHash = value.shownCommand.sha256;
        error.command = JSON.stringify(
          clean(value.shownCommand.command ?? value.shownCommand),
        )
          .replace(
            /(?:Bearer\s+|[A-Z_]*(?:TOKEN|PASSWORD|SECRET|KEY)=)[^\s\"']+/gi,
            "[숨김]",
          )
          .slice(0, 4096);
        throw error;
      }
      throw new AccountError(
        "네이티브 확장 명령에 실패했습니다. 소스·설치 버전·권한을 확인하세요.",
      );
    }
  }
  private configPath(
    t: Target,
    c: { home: string; cwd: string; env: NodeJS.ProcessEnv },
  ) {
    return t.harness === "codex"
      ? join(c.home, "config.toml")
      : c.env.CLAUDE_CONFIG_DIR
        ? join(c.home, ".claude.json")
        : join(homedir(), ".claude.json");
  }
  private settingsPath(t: Target, c: { home: string; cwd: string }) {
    return t.scope === "user"
      ? join(c.home, "settings.json")
      : join(
          c.cwd,
          ".claude",
          t.scope === "local" ? "settings.local.json" : "settings.json",
        );
  }
  private async cfg(
    t: Target,
    c: Awaited<ReturnType<ExtensionManager["context"]>>,
  ) {
    const p = this.configPath(t, c);
    return {
      path: p,
      value:
        t.harness === "claude"
          ? await json(p)
          : ((await text(p)
              .then(parse)
              .catch((e) => {
                if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
                throw e;
              })) as any),
    };
  }
  private record(
    kind: Kind,
    name: string,
    spec: any,
    extra: Partial<ExtensionItem> = {},
    path?: string,
  ): RecordItem {
    if (
      typeof name !== "string" ||
      name.length > 512 ||
      /[\0\r\n]/.test(name) ||
      ["__proto__", "prototype", "constructor"].includes(name)
    )
      throw new AccountError("확장 항목 이름이 올바르지 않습니다.");
    const fingerprint = digest(spec),
      key = `${kind}:${name}`;
    return {
      view: {
        key,
        kind,
        name,
        version: null,
        enabled: true,
        scope: "user",
        source: null,
        editable: true,
        authNeeded: kind === "mcp" && needsAuth(spec),
        components: [],
        fingerprint,
        common: false,
        ...extra,
      },
      spec,
      path,
    };
  }
  async records(t: Target) {
    const c = await this.context(t),
      items: RecordItem[] = [],
      warnings: string[] = [];
    if (t.harness === "claude") {
      const installed = await json(
        join(c.home, "plugins", "installed_plugins.json"),
      );
      for (const [id, rows] of Object.entries(installed.plugins ?? {})) {
        for (const row of rows as any[]) {
          const scope = row.scope ?? "user";
          if (
            scope !== "user" &&
            (t.scope === "user" || resolve(row.projectPath ?? "") !== c.cwd)
          )
            continue;
          const p =
            scope === "user"
              ? join(c.home, "settings.json")
              : join(
                  c.cwd,
                  ".claude",
                  scope === "local" ? "settings.local.json" : "settings.json",
                );
          const enabled = (await json(p)).enabledPlugins?.[id] === true;
          const own =
            typeof row.installPath === "string" &&
            inside(c.home, resolve(row.installPath));
          const bundled = own ? await components(row.installPath) : [];
          items.push(
            this.record(
              "plugin",
              id,
              { selector: id, enabled, version: row.version ?? null },
              {
                version: row.version ?? null,
                enabled,
                scope,
                editable:
                  Boolean(own) && scope !== "managed" && scope === t.scope,
                components: bundled,
                source: id.split("@")[1] ?? null,
              },
              own ? row.installPath : undefined,
            ),
          );
          if (!own)
            warnings.push(
              `${id}: 캐시가 현재 프로필 밖에 있어 네이티브 재설치가 필요할 수 있습니다.`,
            );
        }
      }
      const markets = await json(
        join(c.home, "plugins", "known_marketplaces.json"),
      );
      const declarations = await json(this.settingsPath(t, c));
      for (const [name, m] of Object.entries(markets)) {
        if (t.scope !== "user" && !declarations.extraKnownMarketplaces?.[name])
          continue;
        const v = m as any;
        const src =
          v.source?.repo ?? v.source?.url ?? v.source?.path ?? v.source;
        items.push(
          this.record(
            "marketplace",
            name,
            { source: typeof src === "string" ? src : "", name },
            { source: publicUrl(src), editable: t.scope === "user" },
          ),
        );
      }
    } else {
      try {
        const list = await this.cli(t, ["plugin", "list", "--json"]);
        for (const row of list?.installed ?? []) {
          const id = row.pluginId ?? `${row.name}@${row.marketplaceName}`;
          items.push(
            this.record(
              "plugin",
              id,
              {
                selector: id,
                enabled: row.enabled !== false,
                version: row.version ?? null,
              },
              {
                version: row.version ?? null,
                enabled: row.enabled !== false,
                source: row.marketplaceName ?? null,
                components:
                  typeof row.source?.path === "string"
                    ? await components(row.source.path)
                    : [],
                editable:
                  t.scope === "user" &&
                  ![
                    "managed",
                    "REQUIRED",
                    "FORCE_INSTALLED",
                    "NOT_ALLOWED",
                  ].includes(row.installPolicy),
              },
            ),
          );
        }
        const markets = await this.cli(t, [
          "plugin",
          "marketplace",
          "list",
          "--json",
        ]);
        for (const row of markets?.marketplaces ?? []) {
          const src = row.marketplaceSource?.source ?? row.root;
          items.push(
            this.record(
              "marketplace",
              row.name,
              { source: src, name: row.name },
              { source: publicUrl(src), editable: t.scope === "user" },
            ),
          );
        }
      } catch {
        warnings.push(
          "이 Codex CLI의 플러그인·마켓플레이스 목록을 읽지 못했습니다. CLI 업데이트를 확인하세요.",
        );
      }
    }
    const dirs: { path: string; scope: string }[] = [
      {
        path:
          t.scope === "user"
            ? join(c.home, "skills")
            : join(
                c.cwd,
                t.harness === "claude" ? ".claude" : ".agents",
                "skills",
              ),
        scope: t.scope,
      },
    ];
    if (t.harness === "codex" && (await exists(join(c.home, "skills/.system"))))
      dirs.push({ path: join(c.home, "skills/.system"), scope: "builtin" });
    if (t.harness === "codex")
      dirs.push({ path: join(homedir(), ".agents/skills"), scope: "host" });
    for (const dir of dirs) {
      if (!(await exists(dir.path))) continue;
      for (const entry of await readdir(dir.path, { withFileTypes: true })) {
        let p = join(dir.path, entry.name);
        if (entry.name.startsWith(".")) continue;
        if (entry.isSymbolicLink()) {
          p = await realpath(p).catch(() => "");
          if (!p || !inside(homedir(), p)) continue;
        } else if (!entry.isDirectory()) continue;
        if (await exists(join(p, "SKILL.md"))) {
          try {
            const files = await skillFiles(p),
              fp = digest(
                files.map((f) => [
                  f.rel,
                  createHash("sha256").update(f.data).digest("hex"),
                ]),
              );
            items.push(
              this.record(
                "skill",
                entry.name,
                { fingerprint: fp },
                {
                  scope: dir.scope,
                  editable:
                    dir.scope !== "host" &&
                    dir.scope !== "builtin" &&
                    !entry.isSymbolicLink(),
                  fingerprint: fp,
                  source: dir.scope === "host" ? "호스트 공통" : null,
                },
                p,
              ),
            );
          } catch {
            warnings.push(
              `${entry.name}: 스킬 파일을 안전하게 읽지 못했습니다.`,
            );
          }
        }
      }
    }
    const cfg = await this.cfg(t, c);
    let owner = cfg.value;
    if (t.harness === "claude" && t.scope === "project")
      owner = await json(join(c.cwd, ".mcp.json"));
    if (t.harness === "claude" && t.scope === "local")
      owner = cfg.value.projects?.[c.cwd] ?? {};
    const servers =
      t.harness === "claude"
        ? (owner.mcpServers ?? {})
        : (owner.mcp_servers ?? {});
    for (const [name, spec] of Object.entries(servers))
      items.push(
        this.record("mcp", name, clean(spec), {
          scope: t.harness === "codex" ? "user" : t.scope,
          editable: t.harness === "claude" || t.scope === "user",
          source: publicUrl((spec as any)?.url),
          authNeeded: needsAuth(clean(spec)),
        }),
      );
    const unique = new Map<string, RecordItem>();
    for (const r of items) {
      const previous = unique.get(r.view.key);
      if (
        !previous ||
        (r.view.scope === t.scope && previous.view.scope !== t.scope)
      )
        unique.set(r.view.key, r);
    }
    return { items: [...unique.values()], warnings };
  }
  async inventory(t: Target) {
    await this.ready;
    const { items, warnings } = await this.records(t),
      common = this.state.common[t.harness] ?? [];
    const commonKeys = new Set(common.map((x) => x.view.key));
    let version = "미확인";
    try {
      version = (
        await run(this.commands[t.harness], ["--version"], {
          timeout: 5000,
          maxBuffer: 4096,
        })
      ).stdout
        .trim()
        .slice(0, 100);
    } catch {}
    return {
      items: items.map((x) => ({
        ...x.view,
        common: commonKeys.has(x.view.key),
      })),
      common: common.map((x) => ({ ...x.view, common: true })),
      warnings: [...new Set(warnings)],
      version,
      autoNew: this.state.autoNew,
      autoSwitch: this.state.autoSwitch,
      jobs: this.state.jobs.slice(-15),
    };
  }
  async common(
    t: Target,
    keys: string[],
    remove = false,
    autoNew?: boolean,
    autoSwitch?: boolean,
  ) {
    await this.ready;
    return this.serial(async () => {
      const { items } = await this.records(t),
        saved = this.state.common[t.harness] ?? [];
      if (remove)
        this.state.common[t.harness] = saved.filter(
          (x) => !keys.includes(x.view.key),
        );
      else {
        for (const key of keys) {
          const r = items.find((x) => x.view.key === key);
          if (!r)
            throw new AccountError(
              "선택 항목이 변경되었습니다. 새로고침하세요.",
            );
          if (r.view.kind === "skill") {
            const bundle = join(this.root, "skills", r.view.fingerprint);
            await privateDirectory(bundle);
            for (const f of await skillFiles(r.path!)) {
              await privateDirectory(join(bundle, f.rel, ".."));
              await atomicWrite(join(bundle, f.rel), f.data);
            }
            r.path = bundle;
          }
          r.spec = clean(r.spec);
          this.state.common[t.harness] = [
            ...(this.state.common[t.harness] ?? saved).filter(
              (x) => x.view.key !== key,
            ),
            r,
          ];
        }
      }
      if (autoNew !== undefined) this.state.autoNew = autoNew;
      if (autoSwitch !== undefined) this.state.autoSwitch = autoSwitch;
      await this.save();
      return {
        message: "공통 구성을 저장했습니다. 계정 전용 항목은 유지됩니다.",
      };
    });
  }
  async preview(targets: Target[], keys?: string[]) {
    await this.ready;
    for (const [id, p] of this.plans)
      if (p.expires < Date.now()) this.plans.delete(id);
    if (this.plans.size > 50)
      throw new AccountError(
        "적용 미리보기가 너무 많습니다. 잠시 뒤 다시 시도하세요.",
      );
    const steps: Step[] = [],
      specs: RecordItem[] = [],
      baseline: string[] = [];
    for (const target of targets) {
      const { items } = await this.records(target),
        common = (this.state.common[target.harness] ?? [])
          .filter((r) => !keys || keys.includes(r.view.key))
          .sort(
            (a, b) =>
              Number(b.view.kind === "marketplace") -
              Number(a.view.kind === "marketplace"),
          );
      for (const r of common) {
        const found = items.find(
          (x) =>
            x.view.key === r.view.key &&
            (x.view.scope === target.scope || x.view.scope === "host"),
        );
        const action =
          found && !found.view.editable
            ? "skip"
            : !found
              ? "add"
              : found.view.fingerprint === r.view.fingerprint
                ? "skip"
                : r.view.kind === "plugin" &&
                    found.view.version === r.view.version &&
                    found.view.enabled === r.view.enabled
                  ? "skip"
                  : "conflict";
        steps.push({
          target,
          key: r.view.key,
          name: r.view.name,
          kind: r.view.kind,
          action,
          status: "pending",
          message: null,
          command: null,
          approvalHash: null,
          backupId: null,
        });
        specs.push(structuredClone(r));
        baseline.push(found?.view.fingerprint ?? "");
      }
    }
    const id = randomUUID();
    this.plans.set(id, {
      expires: Date.now() + 600000,
      steps,
      specs,
      baseline,
    });
    return { id, steps };
  }
  async apply(id: string, replace: string[]) {
    await this.ready;
    const p = this.plans.get(id);
    if (!p || p.expires < Date.now())
      throw new AccountError("미리보기가 만료되었습니다. 다시 확인하세요.");
    this.plans.delete(id);
    for (let i = 0; i < p.steps.length; i++) {
      const s = p.steps[i],
        { items } = await this.records(s.target);
      if (
        (items.find(
          (r) =>
            r.view.key === s.key &&
            (r.view.scope === s.target.scope || r.view.scope === "host"),
        )?.view.fingerprint ?? "") !== p.baseline[i]
      )
        throw new AccountError(
          "대상 구성이 변경되었습니다. 변경 내용을 다시 확인하세요.",
        );
      if (s.action === "conflict")
        s.action = replace.includes(`${this.key(s.target)}:${s.key}`)
          ? "update"
          : "skip";
    }
    return {
      job: await this.enqueue(
        p.steps,
        p.specs.map((r, i) => ({ ...r, expected: p.baseline[i] })),
      ),
    };
  }
  private async enqueue(steps: Step[], specs: RecordItem[]) {
    const job: ExtensionJob = {
      id: randomUUID(),
      status: "waiting",
      createdAt: new Date().toISOString(),
      steps: structuredClone(steps),
    };
    await this.serial(async () => {
      if (this.state.jobs.length >= 50) {
        const old = this.state.jobs.findIndex((j) =>
          ["done", "error", "canceled"].includes(j.status),
        );
        if (old < 0)
          throw new AccountError(
            "진행 중인 확장 작업이 너무 많습니다. 완료 후 다시 시도하세요.",
          );
        const [removed] = this.state.jobs.splice(old, 1);
        this.payloads.delete(removed.id);
      }
      this.state.jobs.push(job);
      this.payloads.set(job.id, specs);
      await this.save();
    });
    void this.drive(job).catch(() => {});
    return job;
  }
  async mutate(
    t: Target,
    kind: Kind,
    name: string,
    action: string,
    value?: string,
  ) {
    await this.ready;
    const allowed: Record<Kind, string[]> = {
      plugin: ["install", "update", "remove", "enable", "disable"],
      marketplace: ["install", "update", "remove"],
      skill: ["install", "remove", "edit"],
      mcp: ["install", "remove", "configure", "authenticate"],
    };
    if (!allowed[kind]?.includes(action))
      throw new AccountError("이 항목에서 지원하지 않는 변경입니다.");
    if (
      ["__proto__", "prototype", "constructor", ".", ".."].includes(name) ||
      !name.trim() ||
      /^[.-]|[\/\\\x00-\x1f]/.test(name)
    )
      throw new AccountError(
        "항목 이름에는 경로 구분자·제어 문자·선행 점이나 하이픈을 사용할 수 없습니다.",
      );
    const { items } = await this.records(t),
      found = items.find(
        (r) =>
          r.view.kind === kind &&
          r.view.name === name &&
          r.view.scope === t.scope,
      );
    if (found && !found.view.editable)
      throw new AccountError("이 항목은 호스트·조직에서 관리합니다.");
    let r = found ?? this.record(kind, name, {});
    if (action === "install") {
      if (found)
        throw new AccountError(
          "이미 설치된 항목입니다. 관리에서 업데이트하거나 편집하세요.",
        );
      if (kind === "skill") {
        if (!value) throw new AccountError("스킬 폴더를 입력하세요.");
        const p = await realpath(value);
        const rel = relative(homedir(), p);
        if (isAbsolute(rel) || rel.startsWith(".."))
          throw new AccountError("홈 폴더의 스킬을 선택하세요.");
        if (!(await exists(join(p, "SKILL.md"))))
          throw new AccountError("SKILL.md가 있는 폴더를 선택하세요.");
        const files = await skillFiles(p);
        r = this.record(
          kind,
          name,
          {
            fingerprint: digest(
              files.map((f) => [f.rel, f.data.toString("base64")]),
            ),
          },
          {},
          p,
        );
      } else if (kind === "marketplace")
        r = this.record(kind, name, {
          source: sourceSafe(value ?? name),
          name,
        });
      else if (kind === "plugin")
        r = this.record(kind, name, {
          selector: name,
          enabled: true,
          version: null,
        });
      else {
        let spec;
        try {
          spec = JSON.parse(value ?? "{}");
        } catch {
          throw new AccountError("MCP 설정 JSON을 확인하세요.");
        }
        r = this.record(kind, name, spec);
      }
    } else if (!found) throw new AccountError("설치된 항목을 찾지 못했습니다.");
    if (action === "update" && kind === "marketplace") r = { ...r, spec: {} };
    if (action === "configure") {
      if (kind !== "mcp")
        throw new AccountError("MCP 연결에서 설정을 변경하세요.");
      try {
        r = { ...r, spec: JSON.parse(value ?? "{}") };
      } catch {
        throw new AccountError("MCP 설정 JSON을 확인하세요.");
      }
    }
    if (["enable", "disable"].includes(action) && kind !== "plugin")
      throw new AccountError("플러그인에서만 활성화를 변경할 수 있습니다.");
    if (action === "authenticate" && kind !== "mcp")
      throw new AccountError("MCP 연결에서 인증하세요.");
    if (action === "edit") {
      if (kind !== "skill" || !value)
        throw new AccountError("스킬 내용을 입력하세요.");
      r = { ...r, spec: { text: value } };
    }
    const step: Step = {
      target: t,
      key: r.view.key,
      name,
      kind,
      action:
        action === "install"
          ? "add"
          : action === "edit"
            ? "configure"
            : action === "authenticate"
              ? "configure"
              : (action as any),
      status: "pending",
      message: null,
      command: null,
      approvalHash: null,
      backupId: null,
    };
    if (action === "authenticate") r = { ...r, spec: { authenticate: true } };
    r = { ...r, expected: found?.view.fingerprint ?? "" };
    return { job: await this.enqueue([step], [r]) };
  }
  async details(t: Target, key: string) {
    const r = (await this.records(t)).items.find((r) => r.view.key === key);
    if (!r) throw new AccountError("항목을 찾지 못했습니다.");
    return {
      text:
        r.view.kind === "skill"
          ? await text(join(r.path!, "SKILL.md"))
          : JSON.stringify(clean(r.spec), null, 2),
      editable: r.view.editable,
    };
  }
  async withAccountChange<T>(action: any, operation: () => Promise<T>) {
    const affecting = ["remove", "relogin", "logout-system", "relogin-system"];
    if (!affecting.includes(action.action)) return operation();
    const state = await this.manager.store.read(),
      a = action.id ? state.accounts.find((a) => a.id === action.id) : null;
    const key = `${a?.harness ?? action.harness}:${a?.id ?? "system"}`;
    if (this.locks.has(key))
      throw new AccountError(
        "확장 변경 작업이 진행 중입니다. 완료 후 계정을 변경하세요.",
      );
    this.locks.add(key);
    try {
      return await operation();
    } finally {
      this.locks.delete(key);
    }
  }
  private async idle(t: Target) {
    if (this.manager.isAuthenticating(t.harness, t.accountId)) return false;
    if (!this.paseo) return true;
    const state = await this.manager.store.read(),
      agents = await agentsOn(this.paseo);
    return !agents.some(
      (a) =>
        a.provider === t.harness &&
        (state.bindings[a.id]
          ? state.bindings[a.id].accountId
          : selectedAccount(state, t.harness, a.id)) === t.accountId &&
        (a.activeTurn || ["running", "initializing"].includes(a.status)),
    );
  }
  private async backup(t: Target, paths: string[]) {
    const root = join(this.root, "backups", `${Date.now()}-${randomUUID()}`);
    await privateDirectory(root);
    for (let i = 0; i < paths.length; i++)
      if (await exists(paths[i])) {
        const data = await text(paths[i]);
        await atomicWrite(
          join(root, `${i}.json`),
          JSON.stringify({ path: paths[i], data }),
        );
      }
    return root;
  }

  private async rawMcp(t: Target, name: string) {
    const c = await this.context(t),
      cfg = await this.cfg(t, c);
    const owner =
      t.harness === "claude"
        ? t.scope === "project"
          ? await json(join(c.cwd, ".mcp.json"))
          : t.scope === "local"
            ? (cfg.value.projects?.[c.cwd] ?? {})
            : cfg.value
        : cfg.value;
    return (
      owner[t.harness === "claude" ? "mcpServers" : "mcp_servers"]?.[name] ??
      null
    );
  }
  private async capture(s: Step) {
    if (!["mcp", "skill"].includes(s.kind)) return;
    const c = await this.context(s.target);
    let original: any = null;
    if (s.kind === "mcp") {
      const cfg = await this.cfg(s.target, c);
      const owner =
        s.target.harness === "claude"
          ? s.target.scope === "project"
            ? await json(join(c.cwd, ".mcp.json"))
            : s.target.scope === "local"
              ? (cfg.value.projects?.[c.cwd] ?? {})
              : cfg.value
          : cfg.value;
      original =
        owner[s.target.harness === "claude" ? "mcpServers" : "mcp_servers"]?.[
          s.name
        ] ?? null;
    } else {
      const r = (await this.records(s.target)).items.find(
        (r) => r.view.key === s.key && r.view.scope === s.target.scope,
      );
      if (r)
        original = (await skillFiles(r.path!)).map((f) => ({
          rel: f.rel,
          data: f.data.toString("base64"),
        }));
    }
    await privateDirectory(join(this.root, "backups"));
    s.backupId = randomUUID();
    await atomicWrite(
      join(this.root, "backups", s.backupId + ".json"),
      JSON.stringify({
        target: s.target,
        key: s.key,
        kind: s.kind,
        name: s.name,
        original,
        after: null,
      }),
    );
  }
  private async seal(s: Step) {
    if (!s.backupId) return;
    const path = join(this.root, "backups", s.backupId + ".json"),
      b = await json(path, {}, 30 * 1024 * 1024),
      r = (await this.records(s.target)).items.find(
        (r) => r.view.key === s.key && r.view.scope === s.target.scope,
      );
    b.after = r?.view.fingerprint ?? "";
    b.afterPrivate =
      s.kind === "mcp" ? digest(await this.rawMcp(s.target, s.name)) : b.after;
    await atomicWrite(path, JSON.stringify(b));
  }
  private async restore(s: Step, r: RecordItem) {
    const c = await this.context(s.target),
      b = r.spec.undo;
    if (s.kind === "skill") {
      const dest = join(
        s.target.scope === "user"
          ? c.home
          : join(c.cwd, s.target.harness === "claude" ? ".claude" : ".agents"),
        "skills",
        s.name,
      );
      await safeParents(dest, s.target.scope === "user" ? c.home : c.cwd);
      await rm(dest, { recursive: true, force: true });
      if (b.original) {
        await privateDirectory(dest);
        for (const f of b.original) {
          if (!inside(dest, join(dest, f.rel)))
            throw new AccountError("백업 스킬 경로가 올바르지 않습니다.");
          await privateDirectory(join(dest, f.rel, ".."));
          await atomicWrite(join(dest, f.rel), Buffer.from(f.data, "base64"));
        }
      }
    } else {
      const cfg = await this.cfg(s.target, c),
        path =
          s.target.harness === "claude" && s.target.scope === "project"
            ? join(c.cwd, ".mcp.json")
            : cfg.path,
        value = path === cfg.path ? cfg.value : await json(path);
      let owner = value;
      if (s.target.harness === "claude" && s.target.scope === "local") {
        value.projects ??= {};
        value.projects[c.cwd] ??= {};
        owner = value.projects[c.cwd];
      }
      const key = s.target.harness === "claude" ? "mcpServers" : "mcp_servers";
      owner[key] ??= {};
      if (b.original === null) delete owner[key][s.name];
      else owner[key][s.name] = b.original;
      await safeParents(
        path,
        s.target.scope === "project"
          ? c.cwd
          : s.target.accountId
            ? c.home
            : homedir(),
      );
      await atomicWrite(
        path,
        s.target.harness === "claude"
          ? JSON.stringify(value, null, 2)
          : stringify(value),
      );
    }
  }
  private async execute(s: Step, r: RecordItem, hash?: string) {
    const t = s.target,
      c = await this.context(t);
    if (t.harness === "codex" && t.scope !== "user" && s.kind !== "skill")
      throw new AccountError(
        "이 Codex CLI에서는 해당 항목을 계정 범위로 관리하세요.",
      );
    await privateDirectory(c.home);
    for (const folder of ["skills", "plugins"]) {
      const p = join(c.home, folder);
      if ((await exists(p)) && (await lstat(p)).isSymbolicLink())
        throw new AccountError(
          "확장 디렉터리가 다른 위치에 연결되어 있어 변경하지 않았습니다.",
        );
    }
    if (s.action === "restore") {
      const current = (await this.records(t)).items.find(
        (r) => r.view.key === s.key && r.view.scope === t.scope,
      );
      if ((current?.view.fingerprint ?? "") !== r.spec.undo.after)
        throw new AccountError(
          "백업 이후 구성이 변경되어 덮어쓰지 않았습니다. 현재 설정을 먼저 확인하세요.",
        );
      if (
        s.kind === "mcp" &&
        digest(await this.rawMcp(t, s.name)) !== r.spec.undo.afterPrivate
      )
        throw new AccountError(
          "백업 이후 인증 값이 변경되어 덮어쓰지 않았습니다.",
        );
      await this.restore(s, r);
      return;
    }
    const cfg = await this.cfg(t, c);
    const settingsFile = this.settingsPath(t, c);
    await this.backup(t, [
      cfg.path,
      settingsFile,
      join(c.home, "plugins/installed_plugins.json"),
      join(c.home, "plugins/known_marketplaces.json"),
    ]);
    if (s.kind === "marketplace") {
      if (s.action === "remove") {
        if (
          (this.state.common[t.harness] ?? []).some(
            (r) =>
              r.view.kind === "plugin" &&
              r.spec.selector.endsWith("@" + s.name),
          )
        )
          throw new AccountError(
            "공통 플러그인에서 사용하는 마켓플레이스입니다. 공통 구성에서 먼저 제외하세요.",
          );
        await this.cli(t, ["plugin", "marketplace", "remove", s.name]);
      } else if (s.action === "update")
        await this.cli(t, [
          "plugin",
          "marketplace",
          t.harness === "claude" ? "update" : "upgrade",
          s.name,
        ]);
      else
        await this.cli(t, [
          "plugin",
          "marketplace",
          "add",
          sourceSafe(r.spec.source),
          ...(t.harness === "claude" ? ["--scope", t.scope] : []),
        ]);
      return;
    }
    if (s.kind === "plugin") {
      if (s.action === "enable" || s.action === "disable") {
        if (t.harness === "claude")
          await this.cli(t, [
            "plugin",
            s.action,
            s.name,
            "--scope",
            t.scope,
            "--json",
          ]);
        else {
          cfg.value.plugins ??= {};
          cfg.value.plugins[s.name] = {
            ...cfg.value.plugins[s.name],
            enabled: s.action === "enable",
          };
          await atomicWrite(cfg.path, stringify(cfg.value));
        }
        return;
      }
      if (s.action === "remove")
        await this.cli(t, [
          "plugin",
          t.harness === "claude" ? "uninstall" : "remove",
          s.name,
          ...(t.harness === "claude"
            ? ["--scope", t.scope, "--json"]
            : ["--json"]),
        ]);
      else {
        await this.cli(
          t,
          [
            "plugin",
            t.harness === "claude"
              ? s.action === "update"
                ? "update"
                : "install"
              : "add",
            r.spec.selector,
            ...(t.harness === "claude"
              ? ["--scope", t.scope, "--json"]
              : ["--json"]),
          ],
          hash,
        );
        if (r.spec.enabled === false)
          await this.execute({ ...s, action: "disable" }, r);
      }
      return;
    }
    if (s.kind === "skill") {
      const dest =
        t.scope === "user"
          ? join(c.home, "skills", s.name)
          : join(
              c.cwd,
              t.harness === "claude" ? ".claude" : ".agents",
              "skills",
              s.name,
            );
      await safeParents(dest, t.scope === "user" ? c.home : c.cwd);
      if (await exists(dest)) {
        const st = await lstat(dest);
        if (!st.isDirectory() || st.isSymbolicLink())
          throw new AccountError("스킬 디렉터리가 안전하지 않습니다.");
        const b = join(this.root, "backups", randomUUID());
        await privateDirectory(b);
        for (const f of await skillFiles(dest)) {
          await privateDirectory(join(b, f.rel, ".."));
          await atomicWrite(join(b, f.rel), f.data);
        }
      }
      if (s.action === "remove") {
        await rm(dest, { recursive: true, force: true });
        return;
      }
      await privateDirectory(dest);
      if (r.spec.text) {
        await atomicWrite(join(dest, "SKILL.md"), r.spec.text);
      } else {
        if (await exists(dest)) await rm(dest, { recursive: true });
        await privateDirectory(dest);
        for (const f of await skillFiles(r.path!)) {
          await privateDirectory(join(dest, f.rel, ".."));
          await atomicWrite(join(dest, f.rel), f.data);
        }
      }
      return;
    }
    if (r.spec.authenticate) {
      await this.authenticate(t, s.name);
      return;
    }
    if (!r.spec.command && !r.spec.url && s.action !== "remove")
      throw new AccountError("MCP 설정에 command 또는 url이 필요합니다.");
    if (s.action !== "remove") validateMcp(r.spec, t.harness);
    const path =
      t.harness === "claude" && t.scope === "project"
        ? join(c.cwd, ".mcp.json")
        : cfg.path;
    const value = path === cfg.path ? cfg.value : await json(path);
    const key = t.harness === "claude" ? "mcpServers" : "mcp_servers";
    let owner = value;
    if (t.harness === "claude" && t.scope === "local") {
      value.projects ??= {};
      value.projects[c.cwd] ??= {};
      owner = value.projects[c.cwd];
    }
    owner[key] ??= {};
    if (s.action === "remove") delete owner[key][s.name];
    else owner[key][s.name] = mergePrivate(owner[key][s.name], r.spec);
    await safeParents(
      path,
      t.scope === "project" ? c.cwd : t.accountId ? c.home : homedir(),
    );
    await mkdir(join(path, ".."), { recursive: true });
    await atomicWrite(
      path,
      t.harness === "claude"
        ? JSON.stringify(value, null, 2)
        : stringify(value),
    );
  }
  private async authenticate(t: Target, name: string) {
    const c = await this.context(t),
      launcher = await defaultBrowser();
    const script = join(this.root, `mcp-browser-${randomUUID()}.cjs`);
    await atomicWrite(
      script,
      `#!${process.execPath}\nconst cp=require('node:child_process');const u=new URL(process.argv[2]);if(u.protocol!=='https:')process.exit(1);const env={...process.env};delete env.BROWSER;cp.spawnSync(${JSON.stringify(launcher.command)},[...${JSON.stringify(launcher.args)},u.href],{env,stdio:'ignore'});\n`,
    );
    const { chmod } = await import("node:fs/promises");
    await chmod(script, 0o700);
    try {
      const pending = run(this.commands[t.harness], ["mcp", "login", name], {
        env: {
          ...c.env,
          ...Object.fromEntries(
            Object.entries(launcher.env).filter(([k]) =>
              [
                "DISPLAY",
                "WAYLAND_DISPLAY",
                "XAUTHORITY",
                "XDG_CURRENT_DESKTOP",
                "XDG_SESSION_TYPE",
              ].includes(k),
            ),
          ),
          BROWSER: script,
        },
        cwd: c.cwd,
        timeout: 600000,
        maxBuffer: 65536,
      });
      this.children.add(pending.child);
      try {
        await pending;
      } finally {
        this.children.delete(pending.child);
      }
    } catch {
      throw new AccountError(
        "MCP 인증을 완료하지 못했습니다. 호스트의 기본 브라우저에서 인증 후 다시 확인하세요.",
      );
    } finally {
      await rm(script, { force: true });
    }
  }
  private async drive(job: ExtensionJob) {
    if (this.driving.has(job.id) || this.disposed) return;
    this.driving.add(job.id);
    try {
      await this.runJob(job);
    } catch {
      job.status = "error";
      for (const s of job.steps)
        if (["pending", "waiting", "running"].includes(s.status)) {
          s.status = "error";
          s.message =
            "대상 계정 또는 에이전트 상태를 확인하고 다시 시도하세요.";
        }
      await this.serial(() => this.save());
    } finally {
      this.driving.delete(job.id);
    }
  }
  private async runJob(job: ExtensionJob) {
    if (this.disposed || ["done", "canceled", "approval"].includes(job.status))
      return;
    const specs = this.payloads.get(job.id);
    if (!specs) return;
    for (let i = 0; i < job.steps.length; i++) {
      const s = job.steps[i];
      if (["done", "skipped"].includes(s.status)) continue;
      if (s.status === "running") return;
      const key = this.key(s.target);
      if (this.locks.has(key) || !(await this.idle(s.target))) {
        s.status = "waiting";
        job.status = "waiting";
        await this.serial(() => this.save());
        return;
      }
      this.locks.add(key);
      s.status = "running";
      job.status = "running";
      await this.serial(() => this.save());
      try {
        if (s.action === "skip") {
          s.status = "skipped";
        } else {
          if (specs[i].expected !== undefined) {
            const current = (await this.records(s.target)).items.find(
              (r) => r.view.key === s.key && r.view.scope === s.target.scope,
            );
            if ((current?.view.fingerprint ?? "") !== specs[i].expected)
              throw new AccountError(
                "대기 중에 구성이 변경되었습니다. 현재 내용을 확인하고 다시 적용하세요.",
              );
          }
          if (
            !s.backupId &&
            s.action !== "restore" &&
            !specs[i].spec.authenticate
          )
            await this.capture(s);
          await this.execute(s, specs[i], s.approvalHash ?? undefined);
          if (s.action !== "restore") await this.seal(s);
          s.status = "done";
          s.message = specs[i].view.authNeeded
            ? "계정별 인증 값 확인이 필요합니다."
            : null;
        }
      } catch (e) {
        if (s.backupId) await this.seal(s).catch(() => {});
        s.status = (e as any).approvalHash ? "approval" : "error";
        s.approvalHash = (e as any).approvalHash ?? null;
        s.command = (e as any).command ?? null;
        s.message =
          e instanceof AccountError
            ? e.message
            : "확장 변경을 완료하지 못했습니다. 백업과 원본을 확인하세요.";
        if (s.status === "approval") {
          job.status = "approval";
          await this.serial(() => this.save());
          return;
        }
      } finally {
        this.locks.delete(key);
      }
      await this.serial(() => this.save());
      if ((job.status as string) === "canceled") return;
    }
    const finalStatus = job.steps.some((s) => s.status === "error")
      ? "error"
      : "done";
    if (this.paseo) {
      const done = new Map<string, Target>();
      for (const s of job.steps)
        if (s.status === "done") done.set(this.key(s.target), s.target);
      for (const t of done.values())
        try {
          await this.manager.extensionsChanged(
            t.harness,
            t.accountId,
            this.paseo,
          );
        } catch {
          for (const s of job.steps)
            if (this.key(s.target) === this.key(t) && s.status === "done")
              s.message =
                "구성은 저장했습니다. 에이전트에서 계정 전환 다시 시도로 새 구성을 반영하세요.";
        }
    }
    job.status = finalStatus;
    if (job.status === "done") this.payloads.delete(job.id);
    await this.serial(() => this.save());
  }
  private async resume() {
    if (this.disposed) return;
    await this.ready;
    for (const j of this.state.jobs)
      if (j.status === "waiting") void this.drive(j).catch(() => {});
  }
  async jobs(input: {
    cancel?: string;
    retry?: string;
    restore?: { id: string; index: number; confirmed: true };
    approve?: { id: string; hash: string };
  }) {
    await this.ready;
    if (input.restore) {
      const source = this.state.jobs.find((j) => j.id === input.restore!.id),
        step = source?.steps[input.restore.index];
      if (
        !step?.backupId ||
        !["done", "error"].includes(step.status) ||
        step.action === "restore"
      )
        throw new AccountError("복원 가능한 백업이 없습니다.");
      const b = await json(
        join(this.root, "backups", step.backupId + ".json"),
        {},
        30 * 1024 * 1024,
      );
      if (
        JSON.stringify(b.target) !== JSON.stringify(step.target) ||
        b.key !== step.key ||
        b.after === null
      )
        throw new AccountError("백업 대상을 확인하세요.");
      await this.enqueue(
        [
          {
            ...step,
            action: "restore",
            status: "pending",
            message: null,
            backupId: null,
          },
        ],
        [this.record(step.kind, step.name, { undo: b })],
      );
      return { jobs: this.state.jobs.slice(-15) };
    }
    const id = input.cancel ?? input.retry ?? input.approve?.id,
      j = id ? this.state.jobs.find((j) => j.id === id) : null;
    if (id && !j) throw new AccountError("작업을 찾지 못했습니다.");
    if (j && input.cancel) {
      if (j.steps.some((s) => s.status === "running"))
        throw new AccountError("현재 변경이 끝난 뒤 취소하세요.");
      j.status = "canceled";
      this.payloads.delete(j.id);
    }
    if (j && (input.retry || input.approve)) {
      if (input.retry && j.status === "approval")
        throw new AccountError("네이티브 명령을 먼저 확인하고 승인하세요.");
      if (input.approve && j.status !== "approval")
        throw new AccountError("승인을 기다리는 작업이 아닙니다.");
      if (!this.payloads.has(j.id))
        throw new AccountError(
          "재시작 후에는 적용 내용을 다시 미리보기 하세요.",
        );
      for (const s of j.steps)
        if (s.status === "error" || s.status === "approval") {
          if (input.approve && s.approvalHash !== input.approve.hash)
            throw new AccountError("승인할 명령이 변경되었습니다.");
          s.status = "pending";
        }
      j.status = "waiting";
      void this.drive(j).catch(() => {});
    }
    await this.serial(() => this.save());
    return { jobs: this.state.jobs.slice(-15) };
  }
  async automatic(
    harness: "codex" | "claude",
    accountId: string | null,
    reason: "new" | "switch",
  ) {
    await this.ready;
    if (
      !(reason === "new" ? this.state.autoNew : this.state.autoSwitch) ||
      !this.state.common[harness]?.length
    )
      return;
    if (
      this.state.jobs.some(
        (j) =>
          ["waiting", "running", "approval"].includes(j.status) &&
          j.steps.some(
            (s) => this.key(s.target) === `${harness}:${accountId ?? "system"}`,
          ),
      )
    )
      return;
    const p = await this.preview([
      { harness, accountId, scope: "user", sessionId: null },
    ]);
    if (p.steps.some((s) => s.action === "add")) await this.apply(p.id, []);
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    for (const c of this.children) c.kill("SIGTERM");
  }
}
