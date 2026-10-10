import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  SettingsSchema,
  JobSchema,
  RequestSchema,
  type Settings,
  type Analysis,
  type Candidate,
  type Request,
  type Job,
  type Program,
  type DockerData,
} from "../shared/care.js";
import {
  CareError,
  Runner,
  atomic,
  directory,
  jsonFile,
  type Run,
} from "./util.js";
import { System } from "./system.js";
import { Docker, type Api } from "./docker.js";
type Target = {
  request: Request;
  title: string;
  bytes: number | null;
  impact: string;
  admin: boolean;
  fingerprint: string;
  identity?: string;
  program?: Program;
};
const helperPath = "/usr/local/libexec/paseo-system-care-helper";
export class CareManager {
  readonly root: string;
  readonly system: System;
  readonly docker: Docker;
  private runner = new Runner();
  private run: Run;
  private ready: Promise<void>;
  private settings: Settings = SettingsSchema.parse({});
  private history: Job[] = [];
  private analysis: Analysis = {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    areas: [],
    warnings: [],
    candidates: [],
  };
  private scanController: AbortController | null = null;
  private previews = new Map<string, { expires: number; targets: Target[] }>();
  private payloads = new Map<string, Target[]>();
  private queue = Promise.resolve();
  private writing = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private setupPending = false;
  private setupMessage =
    "관리자 도우미를 설치하면 시스템 캐시 정리를 사용할 수 있습니다.";
  private snapshotPending: Promise<any> | null = null;
  private snapshotDocker = false;
  private cancelRequested = new Set<string>();
  constructor(
    options: {
      root?: string;
      run?: Run;
      system?: System;
      dockerApi?: Api;
      sourceRoot?: string;
    } = {},
  ) {
    this.root = resolve(
      options.root ??
        join(
          process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
          "system-care",
        ),
    );
    this.run = options.run ?? this.runner.run.bind(this.runner);
    this.system = options.system ?? new System(this.run);
    this.docker = new Docker(this.run, options.dockerApi);
    this.sourceRoot = options.sourceRoot;
    this.ready = this.load();
    void this.ready.catch(() => {});
    this.timer = setInterval(() => {
      if (
        !this.disposed &&
        !this.scanController &&
        Date.now() - Date.parse(this.analysis.finishedAt ?? "1970-01-01") >=
          this.settings.analysisMinutes * 60000
      )
        void this.scan().catch(() => {});
    }, 60000);
    this.timer.unref();
  }
  private sourceRoot?: string;
  private async load() {
    await directory(this.root);
    const stored: any = await jsonFile(join(this.root, "state.json"), {
      version: 1,
      settings: {},
      jobs: [],
    });
    if (stored.version !== 1 || !Array.isArray(stored.jobs))
      throw new CareError("시스템 관리 저장 파일을 확인하세요.");
    this.settings = SettingsSchema.parse(stored.settings);
    this.history = stored.jobs.map((j: any) => JobSchema.parse(j));
    for (const j of this.history)
      if (["waiting", "running"].includes(j.status)) {
        j.status = "interrupted";
        j.finishedAt = new Date().toISOString();
        for (const s of j.steps)
          if (["running", "pending"].includes(s.status)) {
            s.status = "error";
            s.message =
              "플러그인이 재시작되었습니다. 현재 상태를 확인한 뒤 다시 미리보기 하세요.";
          }
      }
    await this.save();
  }
  private save() {
    const operation = this.writing.then(() =>
      atomic(
        join(this.root, "state.json"),
        JSON.stringify(
          { version: 1, settings: this.settings, jobs: this.history },
          null,
          2,
        ),
      ),
    );
    this.writing = operation.catch(() => {});
    return operation;
  }
  async helper() {
    try {
      for (const p of [
        helperPath,
        dirname(helperPath),
        "/usr/local",
        "/usr",
        "/",
      ]) {
        const s = await lstat(p);
        if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) !== 0)
          throw Error();
      }
      const p = await lstat(helperPath);
      if (!p.isFile()) throw Error();
      return {
        installed: true,
        message: "요청할 때마다 Ubuntu 관리자 인증을 사용합니다.",
      };
    } catch {
      return {
        installed: false,
        message: this.setupPending
          ? "Ubuntu 호스트에서 관리자 설치 승인 대기 중입니다."
          : this.setupMessage,
      };
    }
  }
  async setupHelper() {
    await this.ready;
    if ((await this.helper()).installed)
      return { message: "관리자 도우미가 이미 설치되어 있습니다." };
    if (this.setupPending)
      return { message: "Ubuntu 호스트에서 설치 승인 대기 중입니다." };
    let src = this.sourceRoot;
    if (!src) {
      const conf: any = await jsonFile(
        join(
          process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
          "config.json",
        ),
        {},
      );
      src = conf.plugins?.["system-care"]?.path;
    }
    if (!src)
      throw new CareError(
        "README의 관리자 도우미 설치 명령을 Ubuntu 호스트에서 실행하세요.",
      );
    const script = join(await realpath(src), "helpers/install.py");
    if (!(await lstat(script)).isFile())
      throw new CareError("관리자 도우미 설치 파일을 찾지 못했습니다.");
    this.setupPending = true;
    void this.run(
      "/usr/bin/pkexec",
      ["--disable-internal-agent", "/usr/bin/python3", "-I", script],
      { timeout: 180000 },
    )
      .then((r) => {
        this.setupMessage = r.code
          ? "설치 승인이 취소되었거나 Ubuntu 인증 창을 사용할 수 없습니다. README의 호스트 설치 명령을 사용하세요."
          : "관리자 도우미 설치를 완료했습니다.";
      })
      .finally(() => {
        this.setupPending = false;
      });
    return {
      message:
        "Ubuntu 호스트의 관리자 인증 창에서 설치를 승인하세요. 정리 작업은 실행하지 않습니다.",
    };
  }
  async snapshot(wantDocker = false) {
    await this.ready;
    if (this.snapshotPending) {
      if (!wantDocker || this.snapshotDocker) return this.snapshotPending;
      await this.snapshotPending;
    }
    this.snapshotDocker = wantDocker;
    this.snapshotPending = (async () => {
      const [metrics, docker, helper] = await Promise.all([
        this.system.snapshot(this.settings),
        wantDocker
          ? this.docker.snapshot(this.settings)
          : Promise.resolve(null),
        this.helper(),
      ]);
      if (this.analysis.status === "idle") void this.scan().catch(() => {});
      return {
        ...metrics,
        docker,
        analysis: this.analysis,
        jobs: this.history.slice(-30),
        settings: this.settings,
        helper,
        warnings: [
          "프로그램별 메모리는 공유 영역이 중복될 수 있는 RSS 합계입니다. 전체 메모리와 합산하지 마세요.",
        ],
      };
    })().finally(() => {
      this.snapshotPending = null;
    });
    return this.snapshotPending;
  }
  async scan(cancel = false) {
    await this.ready;
    if (cancel) {
      this.scanController?.abort();
      return this.analysis;
    }
    if (this.scanController) return this.analysis;
    const controller = new AbortController();
    this.scanController = controller;
    this.analysis = {
      ...this.analysis,
      status: "running",
      startedAt: new Date().toISOString(),
      warnings: [],
    };
    void (async () => {
      try {
        const [areas, caches, d] = await Promise.all([
          this.system.diskAreas(controller.signal),
          this.system.cacheCandidates(controller.signal),
          this.docker.snapshot(this.settings, true),
        ]);
        if (controller.signal.aborted) return;
        this.analysis = {
          ...this.analysis,
          ...areas,
          candidates: [...caches, ...this.docker.candidates(d)],
          status:
            areas.warnings.length || !d.available || d.warnings.length
              ? "partial"
              : "done",
          finishedAt: new Date().toISOString(),
          warnings: [
            ...areas.warnings,
            ...(!d.available ? [d.error ?? "Docker 미조회"] : d.warnings),
          ],
        };
      } catch (e) {
        this.analysis = {
          ...this.analysis,
          status: controller.signal.aborted ? "canceled" : "error",
          finishedAt: new Date().toISOString(),
          warnings: [
            e instanceof CareError ? e.message : "분석을 완료하지 못했습니다.",
          ],
        };
      } finally {
        if (controller.signal.aborted)
          this.analysis = {
            ...this.analysis,
            status: "canceled",
            finishedAt: new Date().toISOString(),
          };
        this.scanController = null;
      }
    })();
    return this.analysis;
  }
  async configure(settings?: Settings) {
    await this.ready;
    if (settings) {
      this.settings = SettingsSchema.parse(settings);
      this.docker.invalidate();
      await this.save();
    }
    return this.settings;
  }
  private async resolveTarget(
    request: Request,
    dockerSnapshot?: DockerData,
  ): Promise<Target> {
    RequestSchema.parse(request);
    const a = request.action,
      t = request.target;
    if (a === "process-stop") {
      const p = (await this.system.snapshot(this.settings, true)).programs.find(
        (p) => p.id === t,
      );
      if (!p || p.protected)
        throw new CareError(
          "이 프로그램은 보호 대상이거나 더 이상 실행 중이지 않습니다.",
        );
      return {
        request,
        title: p.name,
        bytes: null,
        admin: false,
        impact:
          "정상 종료를 요청합니다. 저장하지 않은 작업은 잃을 수 있으며 강제 종료하지 않습니다.",
        fingerprint: p.fingerprint,
        program: p,
      };
    }
    if (["thumbnails", "apt-autoclean", "journal-vacuum"].includes(a)) {
      const c = (await this.system.cacheCandidates()).find(
        (c) => c.action === a && c.id === t,
      );
      if (!c || !c.eligible)
        throw new CareError("정리할 항목이 없거나 보호 대상입니다.");
      if (c.admin && !(await this.helper()).installed)
        throw new CareError("시스템 정리 전에 관리자 도우미를 설치하세요.");
      return {
        request,
        title: c.title,
        bytes: c.bytes,
        impact: c.impact,
        admin: c.admin,
        fingerprint: c.fingerprint,
      };
    }
    const d =
      dockerSnapshot ?? (await this.docker.snapshot(this.settings, true));
    if (!d.available)
      throw new CareError(d.error ?? "Docker 연결을 확인하세요.");
    if (["image-remove", "network-remove", "build-cache"].includes(a)) {
      const c = this.docker
        .candidates(d)
        .find(
          (c) =>
            c.action === a &&
            c.id ===
              (a === "image-remove"
                ? "image:"
                : a === "network-remove"
                  ? "network:"
                  : "builder:") +
                t,
        );
      if (!c || !c.eligible)
        throw new CareError(c?.reason ?? "Docker 정리 대상을 찾지 못했습니다.");
      return {
        request,
        title: c.title,
        bytes: c.bytes,
        admin: false,
        impact: c.impact,
        fingerprint: c.fingerprint,
        identity: d.identity,
      };
    }
    if (a.startsWith("container-")) {
      const c = d.containers.find((c) => c.id === t);
      if (
        !c ||
        this.settings.protectedContainers.includes(c.id) ||
        this.settings.protectedContainers.includes(c.name)
      )
        throw new CareError("컨테이너가 보호 대상이거나 존재하지 않습니다.");
      if (
        (a === "container-start" && c.state === "running") ||
        (a === "container-stop" && c.state !== "running")
      )
        throw new CareError("현재 상태에서는 해당 작업이 필요하지 않습니다.");
      return {
        request,
        title: c.name,
        bytes: null,
        admin: false,
        impact:
          a === "container-start"
            ? "기존 컨테이너를 시작합니다."
            : "서비스가 일시 중단되고 연결된 클라이언트에 영향을 줍니다. 볼륨과 컨테이너는 삭제하지 않습니다.",
        fingerprint: c.fingerprint,
        identity: d.identity,
      };
    }
    if (a.startsWith("compose-")) {
      const s = d.stacks.find((s) => s.name === t);
      if (!s || !s.readable || !s.containers.length)
        throw new CareError("기존 스택의 Compose 설정을 확인하지 못했습니다.");
      if (
        s.containers.some(
          (id) =>
            this.settings.protectedContainers.includes(id) ||
            this.settings.protectedContainers.includes(
              d.containers.find((c) => c.id === id)?.name ?? "",
            ),
        )
      )
        throw new CareError("스택에 보호한 컨테이너가 있습니다.");
      return {
        request,
        title: s.name,
        bytes: null,
        admin: false,
        impact:
          "기존 Compose 컨테이너에만 적용합니다. 중지·재시작하면 해당 스택 서비스가 일시 중단됩니다.",
        fingerprint: s.fingerprint,
        identity: d.identity,
      };
    }
    throw new CareError("허용하지 않은 작업입니다.");
  }
  async autoPreview() {
    await this.ready;
    if (this.history.some((j) => ["waiting", "running"].includes(j.status)))
      throw new CareError("진행 중인 정리가 끝난 뒤 자동 정리를 시작하세요.");
    const [caches, docker] = await Promise.all([
      this.system.cacheCandidates(),
      this.docker.snapshot(this.settings, true),
    ]);
    const candidates = [...caches, ...this.docker.candidates(docker)].filter(
      (c) =>
        c.eligible &&
        [
          "thumbnails",
          "apt-autoclean",
          "journal-vacuum",
          "image-remove",
          "network-remove",
          "build-cache",
        ].includes(c.action),
    );
    if (!candidates.length)
      throw new CareError(
        "현재 자동으로 정리할 항목이 없습니다. 보호 대상과 조회하지 못한 항목은 정리에서 제외합니다.",
      );
    // ponytail: bound each confirmation to 100 items; repeat automatic cleanup for larger inventories.
    const requests = candidates.map((c) => ({
      action: c.action,
      target: c.id.replace(/^(?:image|network|builder):/, ""),
    }));
    const plan = await this.preview(requests.slice(0, 100), docker);
    plan.excluded.push(
      ...requests
        .slice(100)
        .map((request) => ({
          request,
          reason:
            "한 번에 100개까지 처리합니다. 정리가 끝나면 자동 정리를 다시 실행하세요.",
        })),
    );
    return plan;
  }
  async preview(requests: Request[], dockerSnapshot?: DockerData) {
    await this.ready;
    for (const [id, p] of this.previews)
      if (p.expires < Date.now()) this.previews.delete(id);
    if (this.previews.size > 30)
      throw new CareError("미리보기가 너무 많습니다. 잠시 뒤 다시 시도하세요.");
    const targets: Target[] = [],
      excluded: { request: Request; reason: string }[] = [];
    const seen = new Set<string>();
    const d = requests.some(
      (r) =>
        r.action.startsWith("container-") ||
        r.action.startsWith("compose-") ||
        ["image-remove", "network-remove", "build-cache"].includes(r.action),
    )
      ? (dockerSnapshot ?? (await this.docker.snapshot(this.settings, true)))
      : undefined;
    for (const r of requests) {
      const k = JSON.stringify(r);
      if (seen.has(k)) continue;
      seen.add(k);
      try {
        targets.push(await this.resolveTarget(r, d));
      } catch (e) {
        excluded.push({
          request: r,
          reason:
            e instanceof CareError
              ? e.message
              : "대상 상태를 확인하지 못해 보호했습니다.",
        });
      }
    }
    const id = randomUUID(),
      expires = Date.now() + 120000;
    this.previews.set(id, { expires, targets });
    return {
      id,
      expiresAt: new Date(expires).toISOString(),
      steps: targets.map((t) => ({
        request: t.request,
        title: t.title,
        bytes: t.bytes,
        impact: t.impact,
        admin: t.admin,
        status: "pending" as const,
        message: null,
      })),
      excluded,
    };
  }
  async execute(id: string) {
    await this.ready;
    const preview = this.previews.get(id);
    if (!preview || preview.expires < Date.now())
      throw new CareError("승인 미리보기가 만료되었습니다. 다시 확인하세요.");
    this.previews.delete(id);
    if (!preview.targets.length)
      throw new CareError("실행 가능한 대상이 없습니다.");
    const job: Job = {
      id: randomUUID(),
      status: "waiting",
      createdAt: new Date().toISOString(),
      finishedAt: null,
      reclaimedBytes: null,
      steps: preview.targets.map((t) => ({
        request: t.request,
        title: t.title,
        bytes: t.bytes,
        impact: t.impact,
        admin: t.admin,
        status: "pending",
        message: null,
      })),
    };
    if (this.history.length >= 50) {
      const old = this.history.findIndex(
        (j) => !["running", "waiting"].includes(j.status),
      );
      if (old < 0) throw new CareError("진행 중인 작업이 너무 많습니다.");
      this.history.splice(old, 1);
    }
    this.history.push(job);
    this.payloads.set(job.id, preview.targets);
    await this.save();
    this.queue = this.queue
      .then(() => this.perform(job))
      .catch(async () => {
        job.status = "error";
        job.finishedAt = new Date().toISOString();
        for (const s of job.steps)
          if (["running", "pending"].includes(s.status)) {
            s.status = "error";
            s.message =
              "실행 상태를 확인하지 못했습니다. 자동으로 재실행하지 않습니다.";
          }
        this.payloads.delete(job.id);
        await this.save();
      });
    return job;
  }
  private async perform(job: Job) {
    if (this.disposed || (job.status as string) === "canceled") {
      this.payloads.delete(job.id);
      this.cancelRequested.delete(job.id);
      return;
    }
    job.status = "running";
    await this.save();
    const before = (await this.system.snapshot(this.settings, true)).disks;
    const targets = this.payloads.get(job.id)!;
    for (let i = 0; i < targets.length; i++) {
      if (this.disposed) break;
      if (
        (job.status as string) === "canceled" ||
        this.cancelRequested.has(job.id)
      )
        break;
      const step = job.steps[i],
        target = targets[i];
      step.status = "running";
      await this.save();
      let operationStarted = false;
      try {
        const current = await this.resolveTarget(target.request);
        if (
          current.fingerprint !== target.fingerprint ||
          current.identity !== target.identity
        )
          throw new CareError("대상 상태가 변경되어 건너뛰었습니다.");
        operationStarted = true;
        if (target.program)
          await this.system.stop(target.program, this.settings);
        else if (target.request.action === "thumbnails")
          await this.system.cleanThumbnails(target.fingerprint);
        else if (target.admin) {
          const r = await this.run(
            "/usr/bin/pkexec",
            ["--disable-internal-agent", helperPath, target.request.action],
            { timeout: 180000 },
          );
          if (r.code === 126 || r.code === 127)
            throw new CareError(
              "관리자 승인이 취소되었거나 호스트의 인증 창을 사용할 수 없습니다.",
            );
          let result: any;
          try {
            result = JSON.parse(r.stdout);
          } catch {}
          if (r.code || !result?.ok)
            throw new CareError(
              "시스템 정리를 완료하지 못했습니다. 패키지 작업 잠금 또는 권한을 확인하세요.",
            );
        } else
          await this.docker.change(
            target.request,
            this.settings,
            target.fingerprint,
            target.identity!,
          );
        step.status = "done";
        step.message =
          target.request.action === "process-stop"
            ? "정상 종료를 요청했습니다. 사용 중인 프로그램은 종료 요청을 거부할 수 있습니다."
            : null;
      } catch (e) {
        step.status =
          !operationStarted ||
          (e instanceof CareError && /변경|보호|건너/.test(e.message))
            ? "skipped"
            : "error";
        step.message =
          e instanceof CareError
            ? e.message
            : "작업을 완료하지 못했습니다. 원본 상태를 확인하세요.";
      }
      await this.save();
    }
    for (const s of job.steps)
      if (s.status === "pending") s.status = "canceled";
    if (this.cancelRequested.has(job.id)) {
      job.status = "canceled";
      this.cancelRequested.delete(job.id);
    }
    if (this.disposed) job.status = "interrupted";
    else if ((job.status as string) !== "canceled") {
      const done = job.steps.filter((s) => s.status === "done").length;
      job.status =
        done === job.steps.length ? "done" : done ? "partial" : "error";
    }
    job.finishedAt = new Date().toISOString();
    try {
      const after = (await this.system.snapshot(this.settings, true)).disks;
      job.reclaimedBytes = Math.max(
        0,
        after.reduce(
          (n, a) =>
            n +
            Math.max(
              0,
              a.available -
                (before.find((b) => b.device === a.device)?.available ??
                  a.available),
            ),
          0,
        ),
      );
    } catch {}
    this.payloads.delete(job.id);
    await this.save();
    if (!this.disposed) void this.scan().catch(() => {});
  }
  async jobs(cancel?: string) {
    await this.ready;
    if (cancel) {
      const j = this.history.find((j) => j.id === cancel);
      if (!j) throw new CareError("작업을 찾지 못했습니다.");
      if (j.steps.some((s) => s.status === "running")) {
        this.cancelRequested.add(j.id);
        for (const s of j.steps)
          if (s.status === "pending") s.status = "canceled";
        await this.save();
        return { jobs: this.history.slice(-30) };
      }
      if (!["waiting", "running"].includes(j.status))
        throw new CareError("완료한 작업은 취소할 수 없습니다.");
      j.status = "canceled";
      for (const s of j.steps)
        if (s.status === "pending") s.status = "canceled";
      j.finishedAt = new Date().toISOString();
      await this.save();
    }
    return { jobs: this.history.slice(-30) };
  }
  async logs(id: string, tail: number) {
    await this.ready;
    const d = await this.docker.snapshot(this.settings);
    if (!d.available) throw new CareError(d.error ?? "Docker를 확인하세요.");
    return this.docker.logs(id, tail);
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.scanController?.abort();
    this.runner.dispose();
  }
}
