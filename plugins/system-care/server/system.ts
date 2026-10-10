import {
  readFile,
  readdir,
  lstat,
  statfs,
  realpath,
  unlink,
  readlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Program, Settings, Candidate, Analysis } from "../shared/care.js";
import { hash, CareError, inside, type Run } from "./util.js";
export type Proc = {
  pid: number;
  ppid: number;
  uid: number;
  name: string;
  ticks: number;
  start: string;
  rss: number;
  age: number;
  service: string | null;
  container: string | null;
  protect: boolean;
};
const core =
  /^(?:systemd|gnome-shell|gdm.*|dbus.*|NetworkManager|polkit.*|pipewire.*|wireplumber|sshd?|login|init|kthreadd)$/i;
const agents = /paseo|codex|claude|gemini|hermes|system-care/i;
export function protectedPids(rows: Proc[], self = process.pid) {
  const blocked = new Set<number>(),
    trees = new Set<number>();
  for (const p of rows)
    if (
      p.pid <= 2 ||
      p.uid !== process.getuid?.() ||
      core.test(p.name) ||
      agents.test(p.name) ||
      p.container ||
      p.protect
    ) {
      blocked.add(p.pid);
      if (agents.test(p.name) || p.protect || p.pid === self) trees.add(p.pid);
    }
  trees.add(self);
  let ancestor = self;
  for (let i = 0; i < 100; i++) {
    blocked.add(ancestor);
    const p = rows.find((p) => p.pid === ancestor);
    if (!p || !p.ppid || p.ppid === ancestor) break;
    ancestor = p.ppid;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of rows)
      if (trees.has(p.ppid) && !trees.has(p.pid)) {
        trees.add(p.pid);
        changed = true;
      }
  }
  for (const pid of trees) blocked.add(pid);
  return blocked;
}
export class System {
  private prior: {
    at: number;
    ticks: number;
    idle: number;
    processes: Map<number, { start: string; ticks: number }>;
  } | null = null;
  private cache: {
    at: number;
    value: Awaited<ReturnType<System["collect"]>>;
  } | null = null;
  private hz = 100;
  constructor(
    private run: Run,
    readonly procRoot = "/proc",
    readonly home = homedir(),
    readonly uid = process.getuid?.() ?? 1000,
    private signal: (pid: number) => void = (pid) =>
      process.kill(pid, "SIGTERM"),
  ) {}
  async processRows(): Promise<Proc[]> {
    const names = (await readdir(this.procRoot)).filter((x) => /^\d+$/.test(x));
    const uptime = Number(
      (await readFile(join(this.procRoot, "uptime"), "utf8")).split(" ")[0],
    );
    const rows: Proc[] = [];
    for (let at = 0; at < names.length; at += 32) {
      await Promise.all(
        names.slice(at, at + 32).map(async (name) => {
          try {
            const dir = join(this.procRoot, name),
              [raw, status, cgroup] = await Promise.all([
                readFile(join(dir, "stat"), "utf8"),
                readFile(join(dir, "status"), "utf8"),
                readFile(join(dir, "cgroup"), "utf8").catch(() => ""),
              ]);
            const end = raw.lastIndexOf(")"),
              fields = raw.slice(end + 2).split(" "),
              uid = Number(status.match(/^Uid:\s+\d+\s+(\d+)/m)?.[1]);
            if (!Number.isFinite(uid)) return;
            const comm = raw.slice(raw.indexOf("(") + 1, end),
              ticks = Number(fields[11]) + Number(fields[12]),
              start = fields[19],
              rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
            const container =
              cgroup.match(
                /(?:docker[-/]|cri-containerd-)([a-f0-9]{12,64})/,
              )?.[1] ?? null;
            const userService =
              cgroup
                .split("/")
                .filter(
                  (s) =>
                    s.endsWith(".service") && !/^(?:user@|session-)/.test(s),
                )
                .at(-1) ?? null;
            rows.push({
              pid: Number(name),
              ppid: Number(fields[1]),
              uid,
              name: comm,
              ticks,
              start,
              rss,
              age: Math.max(0, uptime - Number(start) / this.hz),
              service:
                uid === this.uid && cgroup.includes("/user.slice/")
                  ? userService
                  : null,
              container,
              protect:
                agents.test(await readlink(join(dir, "exe")).catch(() => "")) ||
                agents.test(userService ?? ""),
            });
          } catch {}
        }),
      );
    }
    return rows.sort((a, b) => a.pid - b.pid);
  }
  private async collect(settings: Settings) {
    const [raw, mem, rows, clock] = await Promise.all([
      readFile(join(this.procRoot, "stat"), "utf8"),
      readFile(join(this.procRoot, "meminfo"), "utf8"),
      this.processRows(),
      this.run("/usr/bin/getconf", ["CLK_TCK"]),
    ]);
    if (!clock.code) this.hz = Number(clock.stdout) || 100;
    const cpuRow = raw
        .split("\n")[0]
        .trim()
        .split(/\s+/)
        .slice(1, 9)
        .map(Number),
      ticks = cpuRow.reduce((a, b) => a + b, 0),
      idle = (cpuRow[3] ?? 0) + (cpuRow[4] ?? 0),
      now = Date.now(),
      old = this.prior;
    const totalDelta = old ? ticks - old.ticks : 0;
    const blocked = protectedPids(rows);
    for (const p of rows)
      if (
        settings.protectedPrograms.includes(p.name) ||
        settings.protectedPrograms.includes(p.service ?? "")
      )
        blocked.add(p.pid);
    const groups = new Map<string, Proc[]>();
    for (const p of rows) {
      let parent = p;
      for (let n = 0; n < 40; n++) {
        const a = rows.find((a) => a.pid === parent.ppid && a.uid === p.uid);
        if (
          !a ||
          core.test(a.name) ||
          /^(bash|sh|zsh|fish|sudo|pkexec|gnome-terminal-)$/.test(a.name)
        )
          break;
        parent = a;
      }
      const key = p.container
        ? "container:" + p.container
        : p.service
          ? "service:" + p.service
          : "pid:" + parent.pid;
      const group = groups.get(key) ?? [];
      group.push(p);
      groups.set(key, group);
    }
    const programs: Program[] = [];
    for (const g of groups.values()) {
      const head = g.find((p) => !g.some((q) => q.pid === p.ppid)) ?? g[0],
        protectedGroup = g.some((p) => blocked.has(p.pid)),
        cpu =
          old && totalDelta > 0
            ? (g.reduce((n, p) => {
                const prev = old.processes.get(p.pid);
                return (
                  n +
                  (prev?.start === p.start
                    ? Math.max(0, p.ticks - prev.ticks)
                    : 0)
                );
              }, 0) /
                totalDelta) *
              100
            : null;
      programs.push({
        id: "program:" + hash(g.map((p) => [p.pid, p.start])).slice(0, 24),
        name: head.name,
        pids: g.map((p) => p.pid),
        cpu,
        rss: g.reduce((n, p) => n + p.rss, 0),
        ageSeconds: Math.max(...g.map((p) => p.age)),
        service: head.service,
        container: head.container,
        protected: protectedGroup,
        reason: g.some((p) => p.container)
          ? "컨테이너는 Docker 탭에서 제어합니다."
          : protectedGroup
            ? "다른 사용자·핵심 시스템·Paseo/코딩 에이전트 보호 대상"
            : "사용자가 직접 선택한 경우에만 정상 종료를 요청합니다.",
        fingerprint: hash(
          g.map((p) => [p.pid, p.start, p.uid, p.name, p.service]),
        ),
      });
    }
    const m = (key: string) =>
      Number(mem.match(new RegExp("^" + key + ":\\s+(\\d+)", "m"))?.[1] ?? 0) *
      1024;
    const disks: {
      mount: string;
      device: string;
      total: number;
      available: number;
      used: number;
    }[] = [];
    const mounts = await readFile(
      join(this.procRoot, "self/mountinfo"),
      "utf8",
    ).catch(() => "");
    const seen = new Set<string>();
    for (const line of mounts.split("\n")) {
      const [a, b] = line.split(" - ");
      if (!b) continue;
      const fields = a.split(" "),
        after = b.split(" "),
        mount = fields[4].replace(/\\040/g, " "),
        device = fields[2];
      if (
        !/^(ext[234]|xfs|btrfs|zfs|f2fs|ntfs3|vfat)$/.test(after[0]) ||
        seen.has(device)
      )
        continue;
      try {
        const s = await statfs(mount),
          total = s.blocks * s.bsize,
          available = s.bavail * s.bsize;
        disks.push({
          mount,
          device,
          total,
          available,
          used: (s.blocks - s.bfree) * s.bsize,
        });
        seen.add(device);
      } catch {}
    }
    if (!disks.length) {
      const s = await statfs("/");
      disks.push({
        mount: "/",
        device: "root",
        total: s.blocks * s.bsize,
        available: s.bavail * s.bsize,
        used: (s.blocks - s.bfree) * s.bsize,
      });
    }
    this.prior = {
      at: now,
      ticks,
      idle,
      processes: new Map(
        rows.map((p) => [p.pid, { start: p.start, ticks: p.ticks }]),
      ),
    };
    return {
      sampledAt: new Date().toISOString(),
      cpu:
        old && totalDelta > 0
          ? Math.max(
              0,
              Math.min(
                100,
                ((totalDelta - (idle - old.idle)) / totalDelta) * 100,
              ),
            )
          : null,
      memory: {
        total: m("MemTotal"),
        available: m("MemAvailable"),
        swapTotal: m("SwapTotal"),
        swapUsed: Math.max(0, m("SwapTotal") - m("SwapFree")),
      },
      disks,
      programs: programs.sort((a, b) => b.rss - a.rss),
    };
  }
  async snapshot(settings: Settings, force = false) {
    if (!force && this.cache && Date.now() - this.cache.at < 4000)
      return this.cache.value;
    const value = await this.collect(settings);
    this.cache = { at: Date.now(), value };
    return value;
  }
  async stop(program: Program, settings: Settings) {
    const current = (await this.snapshot(settings, true)).programs.find(
      (p) => p.id === program.id,
    );
    if (
      !current ||
      current.protected ||
      current.fingerprint !== program.fingerprint
    )
      throw new CareError(
        "프로세스가 변경되었거나 보호 대상이라 종료하지 않았습니다.",
      );
    if (current.service) {
      if (!/^[a-zA-Z0-9@_.:-]+\.service$/.test(current.service))
        throw new CareError("서비스 이름을 확인하세요.");
      const r = await this.run("/usr/bin/systemctl", [
        "--user",
        "stop",
        current.service,
      ]);
      if (r.code)
        throw new CareError("사용자 서비스 종료를 완료하지 못했습니다.");
    } else {
      const rows = await this.processRows(),
        blocked = protectedPids(rows);
      if (
        hash(
          rows
            .filter((p) => current.pids.includes(p.pid))
            .map((p) => [p.pid, p.start, p.uid, p.name, p.service]),
        ) !== current.fingerprint
      )
        throw new CareError("종료 직전 프로세스 식별 정보가 변경되었습니다.");
      for (const pid of current.pids) {
        const p = rows.find((p) => p.pid === pid);
        if (!p || blocked.has(pid) || p.uid !== this.uid)
          throw new CareError("종료 직전 프로세스 상태가 변경되었습니다.");
      }
      for (const pid of [...current.pids].reverse()) {
        try {
          this.signal(pid);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH")
            throw new CareError("정상 종료 신호를 전달하지 못했습니다.");
        }
      }
    }
    this.cache = null;
  }
  async thumbnailFiles(signal?: AbortSignal) {
    const base = join(this.home, ".cache/thumbnails");
    const files: { path: string; bytes: number; fingerprint: string }[] = [];
    let unreadable = false;
    const now = Date.now();
    async function walk(p: string, depth: number) {
      if (signal?.aborted) throw new CareError("작업을 취소했습니다.");
      try {
        const s = await lstat(p);
        if (s.isSymbolicLink()) throw Error();
        if (s.isDirectory()) {
          if (depth > 3) return;
          for (const e of await readdir(p)) await walk(join(p, e), depth + 1);
        } else if (
          s.isFile() &&
          p.endsWith(".png") &&
          s.uid === process.getuid?.() &&
          now - s.mtimeMs > 30 * 86400000
        )
          files.push({
            path: p,
            bytes: s.blocks * 512,
            fingerprint: hash([s.dev, s.ino, s.size, s.mtimeMs]),
          });
      } catch (e) {
        if (signal?.aborted) throw new CareError("작업을 취소했습니다.");
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
      }
    }
    try {
      if ((await lstat(join(this.home, ".cache"))).isSymbolicLink())
        return { files, unreadable: true, fingerprint: hash(files) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        return { files, unreadable: true, fingerprint: hash(files) };
    }
    await walk(base, 0);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, unreadable, fingerprint: hash(files) };
  }
  async cacheCandidates(signal?: AbortSignal): Promise<Candidate[]> {
    const t = await this.thumbnailFiles(signal);
    let aptBytes: number | null = null;
    try {
      aptBytes = 0;
      for (const f of await readdir("/var/cache/apt/archives"))
        if (f.endsWith(".deb"))
          aptBytes +=
            (await lstat(join("/var/cache/apt/archives", f))).blocks * 512;
    } catch {
      aptBytes = null;
    }
    return [
      {
        id: "cache:thumbnails",
        action: "thumbnails",
        title: "30일 이상 지난 썸네일 캐시",
        bytes: t.files.reduce((n, f) => n + f.bytes, 0),
        eligible: t.files.length > 0 && !t.unreadable,
        reason: t.unreadable
          ? "썸네일 캐시 일부를 조회하지 못해 보호합니다."
          : "사용자 소유의 오래된 PNG 미리보기만 정리합니다.",
        impact: "이미지 미리보기를 다시 열 때 썸네일이 재생성됩니다.",
        admin: false,
        fingerprint: t.fingerprint,
      },
      {
        id: "system:apt-autoclean",
        action: "apt-autoclean",
        title: "APT 불필요 다운로드 캐시",
        bytes: aptBytes,
        eligible: aptBytes === null || aptBytes > 0,
        reason:
          "설치된 패키지는 유지하고 APT가 불필요하다고 판정한 다운로드만 정리합니다.",
        impact:
          "표시 용량은 전체 다운로드 캐시이며 실제 정리 용량은 더 작을 수 있습니다.",
        admin: true,
        fingerprint: hash(["apt-autoclean", aptBytes]),
      },
      {
        id: "system:journal-vacuum",
        action: "journal-vacuum",
        title: "30일 이상 지난 보관 시스템 로그",
        bytes: null,
        eligible: true,
        reason:
          "보관된 journal만 대상으로 하며 활성 로그를 강제로 회전시키지 않습니다.",
        impact:
          "삭제한 과거 로그는 복원할 수 없습니다. 관리자 승인 후 실행합니다.",
        admin: true,
        fingerprint: hash("journal-vacuum-30d"),
      },
    ];
  }
  async cleanThumbnails(expected: string) {
    const before = await this.thumbnailFiles();
    if (before.unreadable || before.fingerprint !== expected)
      throw new CareError("캐시 파일이 변경되었거나 조회 권한이 불완전합니다.");
    const base = join(this.home, ".cache/thumbnails"),
      cacheParent = join(this.home, ".cache");
    for (const p of [cacheParent, base]) {
      if ((await lstat(p)).isSymbolicLink())
        throw new CareError("외부 링크가 포함된 캐시는 정리하지 않습니다.");
    }
    for (const f of before.files) {
      if (
        !inside(base, f.path) ||
        !inside(await realpath(base), await realpath(f.path))
      )
        throw new CareError("캐시 경로가 올바르지 않습니다.");
      const probe = await this.run(
        "/usr/bin/lsof",
        ["-nP", "-t", "--", f.path],
        { timeout: 5000 },
      );
      if (probe.stderr.trim() || probe.code > 1 || probe.stdout.trim())
        throw new CareError(
          "열린 파일 또는 미확인 접근이 있어 캐시를 보호했습니다.",
        );
      const s = await lstat(f.path);
      if (
        s.isSymbolicLink() ||
        hash([s.dev, s.ino, s.size, s.mtimeMs]) !== f.fingerprint
      )
        throw new CareError("캐시 파일이 변경되어 정리하지 않았습니다.");
      await unlink(f.path);
    }
  }
  async diskAreas(
    signal: AbortSignal,
  ): Promise<Pick<Analysis, "areas" | "warnings">> {
    const exclusions = [
      "/proc",
      "/sys",
      "/dev",
      "/run",
      "/tmp",
      "/var/lib/docker",
      "/var/lib/containerd",
    ];
    const mounts = await readFile(
      join(this.procRoot, "self/mountinfo"),
      "utf8",
    );
    for (const line of mounts.split("\n")) {
      const mount = line.split(" - ")[0].split(" ")[4];
      if (mount && mount !== "/")
        exclusions.push(
          mount.replace(/\\([0-7]{3})/g, (_, oct) =>
            String.fromCharCode(parseInt(oct, 8)),
          ),
        );
    }
    const r = await this.run(
      "/usr/bin/ionice",
      [
        "-c",
        "3",
        "/usr/bin/nice",
        "-n",
        "10",
        "/usr/bin/du",
        "--one-file-system",
        "--block-size=1",
        "--max-depth=1",
        "--null",
        ...[...new Set(exclusions)].map(
          (p) =>
            "--exclude=" +
            p.replace(/[?*\[\\]/g, (c) =>
              c === "\\" ? "\\\\" : "[" + c + "]",
            ),
        ),
        "/",
      ],
      { timeout: 90000, signal },
    );
    const areas: Analysis["areas"] = [];
    for (const part of r.stdout.split("\0").filter(Boolean)) {
      const i = part.indexOf("\t");
      if (i < 0) continue;
      const n = Number(part.slice(0, i)),
        path = part.slice(i + 1);
      if (Number.isFinite(n) && path.startsWith("/"))
        areas.push({ path, bytes: n, status: r.code ? "partial" : "measured" });
    }
    const warnings = r.code
      ? [
          "용량 분석에 접근하지 못한 영역 또는 시간 제한이 있습니다. 표시한 값은 조회된 범위입니다.",
        ]
      : [];
    for (const a of areas) {
      try {
        await readdir(a.path);
      } catch {
        a.status = "unavailable";
        a.bytes = null;
      }
    }
    for (const p of ["/root", "/var/lib/docker", "/var/lib/containerd"])
      if (!areas.some((a) => a.path === p))
        areas.push({ path: p, bytes: null, status: "unavailable" });
    return {
      areas: areas.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1)),
      warnings,
    };
  }
}
