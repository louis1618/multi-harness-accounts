import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, lstat, chmod, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { type Harness, type Quota, type UsageCounter, type ResetOutcome, harnessLabels } from "../shared/accounts.js";
import { atomicWrite, privateDirectory, AccountError } from "./store.js";
import { codexQuota, codexConsumeReset, claudeQuota, claudeResetIdentity, claudeConsumeReset, readUsage } from "./usage.js";

const execute = promisify(execFile);
export function authorizationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port ||
      !["auth.openai.com/oauth/authorize", "claude.ai/oauth/authorize", "claude.com/cai/oauth/authorize", "console.anthropic.com/oauth/authorize", "platform.claude.com/oauth/authorize"].includes(url.hostname + url.pathname) ||
      ["access_token", "refresh_token", "id_token", "client_secret", "token", "session_key"].some(key => url.searchParams.has(key)) ||
      url.searchParams.has("code") && url.searchParams.get("code") !== "true" || value.length > 16384) return null;
    return url.href;
  } catch { return null; }
}
export async function defaultBrowser(override?: string) {
  const env = { ...process.env }; delete env.BROWSER;
  if (process.platform === "linux") {
    // A background daemon often lacks the graphical session variables; import only the desktop whitelist.
    try { const { stdout } = await execute("systemctl", ["--user", "show-environment"], { timeout: 3000, maxBuffer: 65536 });
      for (const line of stdout.split("\n")) { const at = line.indexOf("="), key = line.slice(0, at), value = line.slice(at + 1);
        if (["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE"].includes(key) && value && value.length < 2048 && !/[\0\r\n]/.test(value)) env[key] = value; }
    } catch { /* The daemon can also run outside a systemd desktop session. */ }
  }
  if (override) return { command: override, args: [] as string[], env };
  if (process.platform === "linux") {
    try {
      const { stdout } = await execute("/usr/bin/xdg-mime", ["query", "default", "x-scheme-handler/https"], { env, timeout: 3000, maxBuffer: 4096 });
      const id = stdout.trim();
      if (/^[A-Za-z0-9_.-]+\.desktop$/.test(id)) {
        const roots = [process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), ...(process.env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share:/var/lib/snapd/desktop").split(":")];
        for (const root of roots) { const file = join(root, "applications", id); try { if ((await lstat(file)).isFile()) return { command: "/usr/bin/gio", args: ["launch", file], env }; } catch { /* Try the next registered desktop location. */ } }
      }
    } catch { /* Keep the OS fallback when no desktop application is registered. */ }
  }
  return { command: process.platform === "darwin" ? "/usr/bin/open" : process.platform === "win32" ? "rundll32.exe" : "/usr/bin/xdg-open", args: process.platform === "win32" ? ["url.dll,FileProtocolHandler"] : [], env };
}
export async function openDefaultBrowser(url: string, override?: string) {
  const link = authorizationUrl(url); if (!link) throw new AccountError("인증 링크가 올바르지 않습니다. 로그인을 다시 시작하세요.");
  const launcher = await defaultBrowser(override);
  try { await execute(launcher.command, [...launcher.args, link], { env: launcher.env, timeout: 10000, maxBuffer: 4096 }); }
  catch { throw new AccountError("호스트의 기본 브라우저를 열지 못했습니다. 표시된 인증 링크를 Firefox에 붙여넣으세요."); }
}
const authVariables: Record<Harness, string[]> = {
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL"],
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
};
async function checkProfileFiles(home: string, harness: Harness) {
  try {
    const stat = await lstat(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AccountError("계정 디렉터리가 안전하지 않습니다.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const names = harness === "codex" ? ["auth.json", "config.toml"] : [".credentials.json", ".claude.json", "settings.json"];
  for (const name of names) {
    try {
      const stat = await lstat(join(home, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AccountError("계정 설정 또는 인증 파일이 안전하지 않아 작업을 중단했습니다.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export interface HarnessAdapter {
  harness: Harness;
  homeVariable: "CODEX_HOME" | "CLAUDE_CONFIG_DIR";
  systemHome: string;
  prepare(home: string): Promise<void>;
  environment(home: string, existing?: Record<string, string>): Record<string, string>;
  status(home: string, native?: boolean): Promise<{ signedIn: boolean; email: string | null; identity: string | null }>;
  quota(home: string, native?: boolean, signal?: AbortSignal): Promise<Quota>;
  usage(home: string, sessionId: string): Promise<UsageCounter>;
  resetIdentity(home: string, native?: boolean): Promise<string | null>;
  consumeReset(home: string, attemptId: string, creditId: string | null, native?: boolean, expectedIdentity?: string, retry?: boolean): Promise<ResetOutcome>;
  login(home: string, native?: boolean, onAuthUrl?: (url: string) => void): Promise<ChildProcess>;
  openLogin(url: string): Promise<void>;
  logout(home: string, native?: boolean): Promise<void>;
  transferHistory(source: string, target: string, sessionId: string): Promise<void>;
}

export function createAdapters(commands: Partial<Record<Harness, string>> = {}, browserOpener?: string, fetchApi: typeof fetch = fetch, browserRoot?: string): Record<Harness, HarnessAdapter> {
  return Object.fromEntries((["codex", "claude"] as const).map(harness => {
    const command = commands[harness] ?? harness;
    const homeVariable = harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const nativeHome = resolve(process.env[homeVariable] ?? join(homedir(), harness === "codex" ? ".codex" : ".claude"));
    const environment = (home: string, existing: Record<string, string> = {}) => {
      if (harness === "codex" && ["OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_IDENTITY_PROVIDER"].some(key =>
        process.env[key] !== undefined || existing[key] !== undefined)) {
        throw new AccountError("Codex 계정을 선택하기 전에 워크로드 인증 환경변수를 제거하세요.");
      }
      return { ...existing, ...Object.fromEntries(authVariables[harness].map(key => [key, ""])), [homeVariable]: home };
    };
    const processEnv = (home: string) => ({ ...process.env, ...environment(home) });
    const nativeEnv = (home: string) => {
      const env = { ...process.env };
      if (resolve(home) !== nativeHome) env[homeVariable] = home;
      return env;
    };
    const identity = (user: string | null, organization = "") =>
      user ? createHash("sha256").update(JSON.stringify([harness, user, organization])).digest("hex") : null;
    const credentialArgs = harness === "codex" ? ["-c", 'cli_auth_credentials_store="file"'] : [];
    const authArgs = harness === "codex" ? ["login"] : ["auth", "login", "--claudeai"];
    const adapter: HarnessAdapter = {
      harness, homeVariable,
      systemHome: nativeHome,
      environment,
      async prepare(home) {
        await privateDirectory(home);
        await checkProfileFiles(home, harness);
        if (harness === "codex") {
          try { await lstat(join(home, "config.toml")); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await atomicWrite(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n');
          }
        }
      },
      async status(home, native = false) {
        // Native discovery is read-only and preserves environment authentication and the native credential store.
        if (!native) await checkProfileFiles(home, harness);
        const statusEnv = native ? nativeEnv(home) : processEnv(home);
        // An unset CLAUDE_CONFIG_DIR also selects ~/.claude.json; setting it to ~/.claude changes that metadata location.
        if (native && resolve(home) !== nativeHome) statusEnv[homeVariable] = home;
        if (harness === "codex") {
          let signedIn = false;
          if (native) {
            try { await execute(command, ["login", "status"], { env: statusEnv, timeout: 10000, maxBuffer: 65536 }); signedIn = true; }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AccountError("이 호스트에 Codex CLI가 설치되지 않았습니다.");
              const failed = error as { code?: unknown; stdout?: string; stderr?: string };
              if (failed.code === 1 && /not logged in|logged out|no credentials/i.test(`${failed.stdout ?? ""} ${failed.stderr ?? ""}`))
                return { signedIn: false, email: null, identity: null };
              throw new AccountError("Codex 로그인 상태를 확인하지 못했습니다. 잠시 후 다시 조회하세요.");
            }
          }
          try {
            const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
            let email: string | null = null;
            let user: string | null = null;
            try {
              const claims = JSON.parse(Buffer.from(auth.tokens?.id_token?.split(".")[1] ?? "", "base64url").toString());
              email = typeof claims.email === "string" && claims.email.length < 255 ? claims.email : null;
              user = typeof claims.sub === "string" ? claims.sub : email?.toLowerCase() ?? null;
            } catch { /* Metadata is optional and is never used for authorization. */ }
            return { signedIn: native ? signedIn : typeof auth.tokens?.access_token === "string" && auth.tokens.access_token.length > 0,
              email, identity: identity(user, typeof auth.tokens?.account_id === "string" ? auth.tokens.account_id : "") };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { signedIn, email: null, identity: null };
            throw new AccountError("Codex 인증 정보를 읽지 못했습니다. 다시 로그인하세요.");
          }
        }
        try {
          const { stdout } = await execute(command, ["auth", "status", "--json"], {
            env: statusEnv, timeout: 10000, maxBuffer: 65536,
          });
          const status = JSON.parse(stdout);
          if (typeof status.loggedIn !== "boolean") throw new Error();
          const email = typeof status.email === "string" && status.email.length < 255 ? status.email : null;
          let oauth: { accountUuid?: string; organizationUuid?: string } = {};
          const metadata = native && !statusEnv.CLAUDE_CONFIG_DIR && resolve(home) === nativeHome
            ? join(homedir(), ".claude.json") : join(home, ".claude.json");
          try {
            const stat = await lstat(metadata);
            if (stat.isFile() && !stat.isSymbolicLink()) oauth = JSON.parse(await readFile(metadata, "utf8")).oauthAccount ?? {};
          } catch { /* Optional native identity metadata; no credential is returned. */ }
          return { signedIn: status.loggedIn === true, email,
            identity: identity(typeof oauth.accountUuid === "string" ? oauth.accountUuid : email?.toLowerCase() ?? null,
              typeof oauth.organizationUuid === "string" ? oauth.organizationUuid : "") };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AccountError("이 호스트에 Claude Code CLI가 설치되지 않았습니다.");
          // Only a verified signed-out response means logout; crashes and timeouts are lookup errors.
          try {
            if (JSON.parse((error as { stdout?: string }).stdout ?? "").loggedIn === false)
              return { signedIn: false, email: null, identity: null };
          } catch { /* An invalid or absent status must not be interpreted as logout. */ }
          throw new AccountError("Claude Code 로그인 상태를 확인하지 못했습니다. 잠시 후 다시 조회하세요.");
        }
      },
      async quota(home, native = false, signal) {
        if (!native) await checkProfileFiles(home, harness);
        return harness === "codex" ? codexQuota(command, native ? nativeEnv(home) : processEnv(home), signal, native ? [] : credentialArgs)
          : claudeQuota(home, fetchApi, signal);
      },
      usage(home, sessionId) { return readUsage(home, harness, sessionId); },
      async resetIdentity(home, native = false) {
        if (!native) await checkProfileFiles(home, harness);
        return harness === "claude" ? claudeResetIdentity(home, fetchApi) : (await adapter.status(home, native)).identity;
      },
      async consumeReset(home, attemptId, creditId, native = false, expectedIdentity, retry = false) {
        if (!native) await checkProfileFiles(home, harness);
        if (harness === "claude") {
          if (!expectedIdentity) throw new AccountError("Claude 리셋 계정을 확인하지 못했습니다.");
          return claudeConsumeReset(home, attemptId, creditId, expectedIdentity, fetchApi, retry);
        }
        return codexConsumeReset(command, native ? nativeEnv(home) : processEnv(home), attemptId, creditId, native ? [] : credentialArgs);
      },
      async login(home, native = false, onAuthUrl) {
        if (!native) await adapter.prepare(home);
        const launcher = await defaultBrowser(browserOpener);
        const env = { ...(native ? nativeEnv(home) : processEnv(home)), ...Object.fromEntries(Object.entries(launcher.env).filter(([key]) => ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE"].includes(key))) };
        delete env.BROWSER;
        const directory = native ? browserRoot ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "harness-accounts", "browser") : home;
        await privateDirectory(directory);
        const capture = join(directory, `.auth-url-${harness}-${randomUUID()}.json`);
        if (process.platform !== "win32") {
          const helper = join(directory, native ? `${harness}.cjs` : ".paseo-open-browser.cjs");
          // A private, short-lived file also captures links when the CLI silences its browser subprocess.
          await atomicWrite(helper, `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');\nconst url=process.argv[2];if(!/^https?:\\/\\//.test(url||''))process.exit(1);\ntry{fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({url}),{flag:'wx',mode:0o600});}catch{}\nconst env={...process.env};delete env.BROWSER;\ncp.spawnSync(${JSON.stringify(launcher.command)},[...${JSON.stringify(launcher.args)},url],{env,stdio:'ignore',timeout:10000});\n// Do not fall through to another browser if the OS launcher cannot open a window.\nprocess.exit(0);\n`);
          await chmod(helper, 0o700); env.BROWSER = helper;
        }
        const child = spawn(command, [...authArgs, ...(native ? [] : credentialArgs)], { env, cwd: native ? homedir() : home, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let active = true, lastUrl: string | null = null;
        const publish = (value: string) => { const url = authorizationUrl(value); if (active && url && url !== lastUrl) { lastUrl = url; onAuthUrl?.(url); } };
        // Output is inspected for allowlisted authorization URLs only; raw output never reaches logs/RPC.
        for (const stream of [child.stdout, child.stderr]) { let buffer = "";
          stream?.on("data", chunk => { buffer = (buffer + chunk.toString()).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").slice(-32768); const at = buffer.lastIndexOf("\n"); if (at < 0) return;
            for (const match of buffer.slice(0, at).matchAll(/https:\/\/[^\s<>"']+/g)) publish(match[0]); buffer = buffer.slice(at + 1); });
          stream?.on("end", () => { for (const match of buffer.matchAll(/https:\/\/[^\s<>"']+/g)) publish(match[0]); });
        }
        const poll = setInterval(() => { void readFile(capture, "utf8").then(data => { try { publish(JSON.parse(data).url); } catch {} }).catch(() => {}); }, 100); poll.unref();
        const cleanup = () => { active = false; clearInterval(poll); void unlink(capture).catch(() => {}); };
        child.once("close", cleanup); child.once("error", cleanup);
        await new Promise<void>((accept, reject) => { child.once("spawn", accept); child.once("error", () => reject(new AccountError(`${harnessLabels[harness]} CLI를 시작하지 못했습니다. 호스트의 설치 상태를 확인하세요.`))); });
        return child;
      },
      openLogin(url) { return openDefaultBrowser(url, browserOpener); },
      async logout(home, native = false) {
        if (!native) await checkProfileFiles(home, harness);
        try {
          await execute(command, harness === "codex" ? ["logout", ...(native ? [] : credentialArgs)] : ["auth", "logout"], {
            env: native ? nativeEnv(home) : processEnv(home), cwd: native ? homedir() : home, timeout: 10000, maxBuffer: 65536,
          });
        } catch { throw new AccountError(`${harnessLabels[harness]} 로그아웃에 실패해 계정을 유지했습니다.`); }
      },
      transferHistory(source, target, sessionId) { return transferHistory(harness, source, target, sessionId); },
    };
    return [harness, adapter];
  })) as Record<Harness, HarnessAdapter>;
}

export async function filesUnder(root: string): Promise<string[]> {
  let entries;
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AccountError("대화 기록 디렉터리가 안전하지 않습니다.");
    entries = await readdir(root, { withFileTypes: true });
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new AccountError("대화 기록에 심볼릭 링크가 있어 전환을 중단했습니다.");
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

export async function transferHistory(harness: Harness, source: string, target: string, sessionId: string) {
  if (resolve(source) === resolve(target)) return;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new AccountError("네이티브 세션 ID가 올바르지 않습니다.");
  const roots = harness === "codex" ? ["sessions", "archived_sessions"] : ["projects"];
  let copied = 0;
  // ponytail: scan native transcript paths at switch time; add a per-session index if large histories make switching slow.
  for (const root of roots) {
    const sourceRoot = join(source, root);
    const sourceFiles = await filesUnder(sourceRoot);
    for (const path of sourceFiles) {
      const relativePath = relative(sourceRoot, path);
      const parts = relativePath.split(/[\\/]/);
      const name = parts.at(-1)!;
      const selected = harness === "codex"
        ? name.endsWith(`-${sessionId}.jsonl`)
        : name === `${sessionId}.jsonl` || parts.includes(sessionId);
      if (!selected) continue;
      const destination = join(target, root, relativePath);
      // Check each destination ancestor so a pre-existing symlink cannot redirect a transcript.
      let directory = target;
      await privateDirectory(directory);
      for (const part of [root, ...parts.slice(0, -1)]) {
        directory = join(directory, part);
        await privateDirectory(directory);
      }
      await atomicWrite(destination, await readFile(path));
      copied++;
    }
  }
  if (!copied) throw new AccountError("원본 대화 기록을 찾지 못했습니다. 기록을 보존하기 위해 계정 전환을 중단했습니다.");
}
