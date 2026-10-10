import http from "node:http";
import { readFile, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  DockerData,
  Settings,
  Request,
  Candidate,
} from "../shared/care.js";
import { CareError, hash, redact, type Run } from "./util.js";
export const emptyDocker = (error: string | null = null): DockerData => ({
  available: false,
  error,
  identity: "",
  socket: "",
  containers: [],
  images: [],
  volumes: [],
  networks: [],
  stacks: [],
  usage: {
    imageBytes: null,
    imageReclaimable: null,
    volumeBytes: null,
    containerBytes: null,
    buildBytes: null,
  },
  composeComplete: false,
  warnings: [],
});
export function imageRef(s: string) {
  if (s.startsWith("sha256:")) return s;
  let [name, digest] = s.split("@");
  if (!name.includes("/") || !/[.:]/.test(name.split("/")[0]))
    name = "docker.io/" + (name.includes("/") ? "" : "library/") + name;
  if (!digest && !name.split("/").at(-1)!.includes(":")) name += ":latest";
  return name + (digest ? "@" + digest : "");
}
export type Api = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<any>;
export class Docker {
  private version = "";
  private socket = "";
  private identity = "";
  private cached: { at: number; value: DockerData; settings: string } | null =
    null;
  readonly cli = "/usr/local/bin/docker";
  constructor(
    private run: Run,
    private apiOverride?: Api,
    private socketOverride?: string,
  ) {}
  async api(method: string, path: string, body?: unknown) {
    if (this.apiOverride) return this.apiOverride(method, path, body);
    if (!this.socket) throw new CareError("Docker 연결을 먼저 확인하세요.");
    return new Promise<any>((ok, no) => {
      const req = http.request(
        {
          socketPath: this.socket,
          path: this.version + path,
          method,
          headers: body ? { "content-type": "application/json" } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (b) => {
            size += b.length;
            if (size > 32 * 1024 * 1024) {
              req.destroy();
              no(new CareError("Docker 응답이 너무 큽니다."));
            } else chunks.push(b);
          });
          res.on("end", () => {
            if ((res.statusCode ?? 500) >= 400) {
              no(
                new CareError(
                  `Docker 작업을 완료하지 못했습니다. 상태와 참조 관계를 확인하세요. (${res.statusCode})`,
                ),
              );
              return;
            }
            const raw = Buffer.concat(chunks);
            if (path.includes("/logs?")) {
              ok(raw);
              return;
            }
            try {
              ok(JSON.parse(raw.toString() || "null"));
            } catch {
              ok(raw);
            }
          });
        },
      );
      req.setTimeout(15000, () =>
        req.destroy(new CareError("Docker 응답 시간이 초과되었습니다.")),
      );
      req.on("error", () =>
        no(
          new CareError(
            "Docker 연결을 사용할 수 없습니다. 권한 또는 실행 상태를 확인하세요.",
          ),
        ),
      );
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
  private async connect() {
    if (this.apiOverride) {
      this.socket = "fixture";
      this.identity = "fixture-engine";
      return;
    }
    const paths = this.socketOverride
      ? [this.socketOverride]
      : [
          "/var/run/docker.sock",
          `/run/user/${process.getuid?.() ?? 1000}/docker.sock`,
        ];
    if (this.socket) paths.splice(0, paths.length, this.socket);
    for (const p of paths) {
      try {
        const actual = await realpath(p),
          s = await lstat(actual);
        if (!s.isSocket()) continue;
        this.socket = actual;
        this.version = "";
        const v = await this.api("GET", "/version");
        if (!/^\d+\.\d+$/.test(v.ApiVersion)) throw Error();
        this.version = "/v" + v.ApiVersion;
        const info = await this.api("GET", "/info");
        this.identity = hash([info.ID, actual, s.dev, s.ino]);
        return;
      } catch {
        this.version = "";
        this.socket = "";
      }
    }
    throw new CareError(
      "로컬 Docker에 연결하지 못했습니다. 소켓 권한은 자동 변경하지 않습니다.",
    );
  }
  invalidate() {
    this.cached = null;
  }
  async snapshot(settings: Settings, force = false): Promise<DockerData> {
    const signature = hash(settings);
    if (
      !force &&
      this.cached &&
      Date.now() - this.cached.at < 5000 &&
      this.cached.settings === signature
    )
      return this.cached.value;
    try {
      await this.connect();
      const [rows, images, volumes, networks, df] = await Promise.all([
        this.api("GET", "/containers/json?all=1&size=1"),
        this.api("GET", "/images/json?all=1"),
        this.api("GET", "/volumes"),
        this.api("GET", "/networks"),
        this.api("GET", "/system/df"),
      ]);
      const value = emptyDocker();
      value.available = true;
      value.socket = this.socket;
      value.identity = this.identity;
      value.composeComplete = true;
      value.containers = rows.map((r: any) => ({
        id: r.Id,
        name: (r.Names?.[0] ?? r.Id.slice(0, 12)).replace(/^\//, ""),
        image: r.Image,
        state: r.State,
        status: r.Status ?? r.State,
        project: r.Labels?.["com.docker.compose.project"] ?? null,
        cpu: null,
        memory: null,
        writableBytes: r.SizeRw ?? null,
        volumes: (r.Mounts ?? [])
          .filter((m: any) => m.Type === "volume")
          .map((m: any) => m.Name),
        networks: Object.keys(r.NetworkSettings?.Networks ?? {}),
        fingerprint: hash([
          r.Id,
          r.ImageID,
          r.State,
          r.Labels,
          r.Mounts,
          r.NetworkSettings,
        ]),
      }));
      const stacks = new Map<
        string,
        { files: Set<string>; containers: string[] }
      >();
      for (const r of rows) {
        const name = r.Labels?.["com.docker.compose.project"];
        if (!name) continue;
        const group = stacks.get(name) ?? { files: new Set(), containers: [] };
        for (const f of String(
          r.Labels?.["com.docker.compose.project.config_files"] ?? "",
        )
          .split(",")
          .filter(Boolean))
          group.files.add(f);
        group.containers.push(r.Id);
        stacks.set(name, group);
      }
      for (const f of settings.composeFiles) {
        const known = [...stacks.values()].some((g) => g.files.has(f));
        if (!known)
          stacks.set("registered-" + hash(f).slice(0, 8), {
            files: new Set([f]),
            containers: [],
          });
      }
      const refs = new Set<string>(),
        networkRefs = new Set<string>();
      for (const [name, g] of stacks) {
        let readable = g.files.size > 0;
        const files = [...g.files];
        let resolvedImages: string[] = [];
        let configFingerprint = "";
        try {
          if (!files.length) throw Error();
          const data = [];
          for (const f of files) {
            if (!f.startsWith("/")) throw Error();
            const s = await lstat(f);
            if (!s.isFile() || s.isSymbolicLink() || s.size > 2 * 1024 * 1024)
              throw Error();
            data.push([f, s.dev, s.ino, s.size, s.mtimeMs]);
          }
          const args = [
            "--host",
            "unix://" + this.socket,
            "compose",
            "--profile",
            "*",
            ...(name.startsWith("registered-") ? [] : ["--project-name", name]),
            ...files.flatMap((f) => ["-f", f]),
            "config",
            "--format",
            "json",
          ];
          const out = await this.run(this.cli, args, { timeout: 15000 });
          if (out.code) throw Error();
          const config = JSON.parse(out.stdout);
          for (const service of Object.values(config.services ?? {}) as any[]) {
            if (typeof service.image === "string") {
              if (!/^[a-zA-Z0-9_./:@-]+$/.test(service.image)) throw Error();
              resolvedImages.push(imageRef(service.image));
            } else if (!service.build) throw Error();
          }
          for (const [key, n] of Object.entries(config.networks ?? {})) {
            const item = n as any;
            networkRefs.add(item.name ?? name + "_" + key);
          }
          configFingerprint = hash([data, resolvedImages, [...networkRefs]]);
        } catch {
          readable = false;
          value.composeComplete = false;
          value.warnings.push(
            `${name}: Compose 참조를 모두 확인하지 못해 이미지·네트워크 정리를 보호했습니다.`,
          );
        }
        for (const r of resolvedImages) refs.add(r);
        value.stacks.push({
          name,
          files,
          containers: g.containers,
          readable,
          fingerprint: hash([name, g.containers, configFingerprint, readable]),
        });
      }
      const stats = await this.run(
        this.cli,
        [
          "--host",
          "unix://" + this.socket,
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
        ],
        { timeout: 10000 },
      );
      if (!stats.code)
        for (const line of stats.stdout.trim().split("\n").filter(Boolean)) {
          try {
            const r = JSON.parse(line),
              c = value.containers.find((c) => c.id.startsWith(r.ID));
            if (c) {
              const percent = Number.parseFloat(r.CPUPerc);
              c.cpu = Number.isFinite(percent) ? percent : null;
              c.memory = parseBytes(r.MemUsage.split("/")[0]);
            }
          } catch {}
        }
      else value.warnings.push("컨테이너 실시간 사용량을 조회하지 못했습니다.");
      value.images = images.map((r: any) => {
        const tags = r.RepoTags ?? [],
          references = value.containers
            .filter((c, i) => rows[i].ImageID === r.Id)
            .map((c) => c.name);
        const used = references.length > 0;
        const declared = [...tags, ...(r.RepoDigests ?? [])].some((t) =>
          refs.has(imageRef(t)),
        );
        const local = !r.RepoDigests?.length;
        const pinned = settings.protectedImages.some(
          (t) => t === r.Id || tags.includes(t),
        );
        const reason = used
          ? "실행·중지 컨테이너에서 사용 중"
          : declared
            ? "Compose에서 참조 중"
            : pinned
              ? "사용자 보호 목록"
              : !value.composeComplete
                ? "Compose 참조 미확인"
                : local
                  ? "다운로드 출처를 확인하지 못한 로컬 이미지"
                  : tags.length > 1
                    ? "여러 태그가 같은 이미지를 사용 중"
                    : "컨테이너·Compose 참조 없음";
        return {
          id: r.Id,
          tags,
          size: r.Size ?? 0,
          uniqueSize:
            (df.Images ?? []).find((i: any) => i.Id === r.Id)?.SharedSize >= 0
              ? Math.max(
                  0,
                  r.Size -
                    (df.Images ?? []).find((i: any) => i.Id === r.Id)
                      .SharedSize,
                )
              : null,
          references,
          protected:
            used ||
            declared ||
            pinned ||
            !value.composeComplete ||
            local ||
            tags.length > 1,
          reason,
          fingerprint: hash([
            r.Id,
            tags,
            r.RepoDigests,
            references,
            declared,
            value.composeComplete,
          ]),
        };
      });
      const usedVolumes = df.Volumes ?? [];
      value.volumes = (volumes.Volumes ?? []).map((v: any) => ({
        name: v.Name,
        driver: v.Driver,
        references: value.containers
          .filter((c) => c.volumes.includes(v.Name))
          .map((c) => c.name),
        bytes:
          usedVolumes.find((x: any) => x.Name === v.Name)?.UsageData?.Size >= 0
            ? usedVolumes.find((x: any) => x.Name === v.Name).UsageData.Size
            : null,
      }));
      value.networks = networks.map((n: any) => {
        const references = value.containers
            .filter((c) => c.networks.includes(n.Name))
            .map((c) => c.name),
          protectedNetwork =
            ["bridge", "host", "none"].includes(n.Name) ||
            n.Ingress ||
            n.Scope !== "local" ||
            references.length > 0 ||
            networkRefs.has(n.Name) ||
            settings.protectedNetworks.includes(n.Name) ||
            !value.composeComplete;
        return {
          id: n.Id,
          name: n.Name,
          driver: n.Driver,
          references,
          protected: !!protectedNetwork,
          reason: references.length
            ? "컨테이너에서 사용 중"
            : networkRefs.has(n.Name)
              ? "Compose에서 참조 중"
              : protectedNetwork
                ? "기본·보호 네트워크 또는 참조 미확인"
                : "미사용 네트워크",
          fingerprint: hash([
            n.Id,
            n.Name,
            n.Containers,
            n.Options,
            n.Labels,
            references,
            protectedNetwork,
          ]),
        };
      });
      value.usage = {
        imageBytes: df.LayersSize ?? null,
        imageReclaimable: df.Images?.every((i: any) => i.SharedSize >= 0)
          ? df.Images.filter((i: any) => i.Containers === 0).reduce(
              (sum: number, i: any) => sum + Math.max(0, i.Size - i.SharedSize),
              0,
            )
          : null,
        containerBytes: df.Containers
          ? df.Containers.reduce((n: number, c: any) => n + (c.SizeRw ?? 0), 0)
          : null,
        volumeBytes: df.Volumes?.every((v: any) => v.UsageData?.Size >= 0)
          ? df.Volumes.reduce(
              (n: number, v: any) => n + Math.max(0, v.UsageData?.Size ?? 0),
              0,
            )
          : null,
        buildBytes: df.BuildCache
          ? df.BuildCache.reduce((n: number, c: any) => n + (c.Size ?? 0), 0)
          : null,
      };
      // ponytail: Docker's per-image reclaim estimates can overlap; actual savings come from filesystem measurements.
      this.cached = { at: Date.now(), settings: signature, value };
      return value;
    } catch (e) {
      return emptyDocker(
        e instanceof CareError ? e.message : "Docker 목록을 읽지 못했습니다.",
      );
    }
  }
  candidates(d: DockerData): Candidate[] {
    if (!d.available) return [];
    return [
      ...d.images.map((i) => ({
        id: "image:" + i.id,
        action: "image-remove" as const,
        title: i.tags[0] ?? i.id.slice(0, 20),
        bytes: i.uniqueSize,
        eligible: !i.protected,
        reason: i.reason,
        impact:
          "이미지 재사용 시 다시 다운로드해야 합니다. 공유 레이어가 남으면 확보 용량은 줄어듭니다.",
        admin: false,
        fingerprint: i.fingerprint,
      })),
      ...d.networks.map((n) => ({
        id: "network:" + n.id,
        action: "network-remove" as const,
        title: n.name,
        bytes: null,
        eligible: !n.protected,
        reason: n.reason,
        impact: "사용하지 않는 네트워크 설정을 제거합니다.",
        admin: false,
        fingerprint: n.fingerprint,
      })),
      {
        id: "builder:default",
        action: "build-cache" as const,
        title: "기본 로컬 Docker 빌드 캐시",
        bytes: d.usage.buildBytes,
        eligible: (d.usage.buildBytes ?? 0) > 0,
        reason: "30일 이상 미사용 캐시만 정리하고 5GB를 보존합니다.",
        impact:
          "기본 로컬 builder만 대상으로 하며 이후 빌드가 느려질 수 있습니다.",
        admin: false,
        fingerprint: hash([d.identity, d.usage.buildBytes]),
      },
    ];
  }
  async change(
    request: Request,
    settings: Settings,
    expected: string,
    identity: string,
  ) {
    const d = await this.snapshot(settings, true);
    if (!d.available || d.identity !== identity)
      throw new CareError("Docker 연결이 변경되었습니다. 다시 확인하세요.");
    const action = request.action,
      t = request.target;
    if (action === "image-remove") {
      const i = d.images.find((i) => i.id === t);
      if (!i || i.protected || i.fingerprint !== expected)
        throw new CareError("이미지 참조가 변경되어 건너뛰었습니다.");
      await this.api(
        "DELETE",
        "/images/" +
          encodeURIComponent(i.tags[0] ?? i.id) +
          "?force=0&noprune=1",
      );
    } else if (action === "network-remove") {
      const n = d.networks.find((n) => n.id === t);
      if (!n || n.protected || n.fingerprint !== expected)
        throw new CareError("네트워크 참조가 변경되어 건너뛰었습니다.");
      await this.api("DELETE", "/networks/" + encodeURIComponent(n.id));
    } else if (action === "build-cache") {
      if (
        t !== "default" ||
        hash([d.identity, d.usage.buildBytes]) !== expected
      )
        throw new CareError("빌드 캐시가 변경되었습니다.");
      const builder = await this.run(this.cli, [
        "--host",
        "unix://" + this.socket,
        "buildx",
        "inspect",
        "default",
      ]);
      const context = await this.run(this.cli, [
        "context",
        "inspect",
        "default",
        "--format",
        "{{.Endpoints.docker.Host}}",
      ]);
      if (
        builder.code ||
        context.code ||
        !/^Driver:\s+docker$/m.test(builder.stdout) ||
        !/^Endpoint:\s+default$/m.test(builder.stdout) ||
        (await realpath(context.stdout.trim().replace(/^unix:\/\//, ""))) !==
          this.socket
      )
        throw new CareError(
          "기본 builder가 이 로컬 Docker 연결을 사용하지 않아 정리하지 않았습니다.",
        );
      const r = await this.run(
        this.cli,
        [
          "--host",
          "unix://" + this.socket,
          "buildx",
          "prune",
          "--builder",
          "default",
          "--filter",
          "until=720h",
          "--reserved-space",
          "5GB",
          "--force",
        ],
        { timeout: 120000 },
      );
      if (r.code) throw new CareError("빌드 캐시 정리에 실패했습니다.");
    } else if (action.startsWith("container-")) {
      const c = d.containers.find((c) => c.id === t);
      if (
        !c ||
        c.fingerprint !== expected ||
        settings.protectedContainers.includes(c.id) ||
        settings.protectedContainers.includes(c.name)
      )
        throw new CareError("컨테이너 상태가 바뀌었거나 보호 대상입니다.");
      const operation = action.slice(10);
      await this.api(
        "POST",
        "/containers/" +
          encodeURIComponent(c.id) +
          "/" +
          operation +
          (operation === "start" ? "" : "?t=20"),
      );
    } else if (action.startsWith("compose-")) {
      const s = d.stacks.find((s) => s.name === t);
      if (
        !s ||
        !s.readable ||
        !s.containers.length ||
        s.fingerprint !== expected ||
        s.containers.some(
          (id) =>
            settings.protectedContainers.includes(id) ||
            settings.protectedContainers.includes(
              d.containers.find((c) => c.id === id)?.name ?? "",
            ),
        )
      )
        throw new CareError("Compose 상태가 바뀌었거나 보호 대상입니다.");
      if (!/^[a-z0-9][a-z0-9_-]+$/.test(s.name))
        throw new CareError("이 스택 이름으로는 작업할 수 없습니다.");
      const r = await this.run(
        this.cli,
        [
          "--host",
          "unix://" + this.socket,
          "compose",
          "--project-name",
          s.name,
          "--profile",
          "*",
          ...s.files.flatMap((f) => ["-f", f]),
          action.slice(8),
        ],
        { timeout: 60000 },
      );
      if (r.code) throw new CareError("Compose 작업을 완료하지 못했습니다.");
    } else throw new CareError("지원하지 않는 Docker 작업입니다.");
    this.invalidate();
  }
  async logs(id: string, tail: number) {
    const list = await this.api("GET", "/containers/json?all=1");
    if (!list.some((c: any) => c.Id === id))
      throw new CareError("컨테이너를 찾지 못했습니다.");
    const c = await this.api(
        "GET",
        "/containers/" + encodeURIComponent(id) + "/json",
      ),
      raw = await this.api(
        "GET",
        "/containers/" +
          encodeURIComponent(id) +
          `/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
      );
    let b = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)),
      parts: Buffer[] = [];
    if (!c.Config?.Tty) {
      let at = 0;
      while (
        at + 8 <= b.length &&
        b[at] <= 2 &&
        b[at + 1] === 0 &&
        b[at + 2] === 0 &&
        b[at + 3] === 0
      ) {
        const n = b.readUInt32BE(at + 4);
        if (at + 8 + n > b.length) break;
        parts.push(b.subarray(at + 8, at + 8 + n));
        at += 8 + n;
      }
      if (parts.length) b = Buffer.concat(parts);
    }
    const secrets = (c.Config?.Env ?? [])
      .filter((s: string) =>
        /token|secret|password|key|cookie/i.test(s.split("=")[0]),
      )
      .map((s: string) => s.slice(s.indexOf("=") + 1));
    const hidden = Buffer.from(redact(b.toString(), secrets));
    return {
      text: hidden.subarray(Math.max(0, hidden.length - 65536)).toString(),
      truncated: hidden.length > 65536,
    };
  }
}
function parseBytes(s: string) {
  const m = s.trim().match(/^([\d.]+)\s*([kMGT]?i?B)$/i);
  if (!m) return null;
  const unit = m[2].toUpperCase(),
    n = ["B", "KIB", "MIB", "GIB", "TIB"].indexOf(unit);
  return (
    Number(m[1]) *
    (n >= 0 ? 1024 ** n : 1000 ** ["B", "KB", "MB", "GB", "TB"].indexOf(unit))
  );
}
