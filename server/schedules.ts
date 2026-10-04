import { randomUUID } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { HarnessSchema, type Quota } from "../shared/accounts.js";
import { activeSchedule, scheduleCard, type Schedule } from "../shared/schedules.js";
import { AccountManager, selectedAccount, isUsageLimitFailure } from "./manager.js";
import { AccountError } from "./store.js";
import { QuotaError, QuotaCache } from "./usage.js";

type PaseoApi = PluginHandlerContext["paseo"];
type Agent = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"];
const DAY = 86400000;
export function resetFor(quota: Quota, model: string | null, now: number) {
  const windows = quota.windows.filter(w => !w.scope || !model || model.toLowerCase().includes(w.scope.toLowerCase()) ||
    !/opus|sonnet|haiku|gpt|review|spark|image/i.test(w.scope));
  const blocked = windows.filter(w => w.usedPercent >= 100);
  const next = windows.filter(w => (w.durationMinutes === 300 || w.durationMinutes === 10080) && w.resetsAt && Date.parse(w.resetsAt) > now)
    .sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))[0];
  const at = next?.resetsAt ?? null;
  return { blocked: blocked.length > 0, stale: blocked.length > 0 && blocked.every(w => w.resetsAt && Date.parse(w.resetsAt) <= now), at,
    reason: next ? `가장 빠른 초기화 · ${next.label}` : "5시간·주간 한도의 초기화 시각이 제공되지 않습니다. 시간을 직접 지정하세요." };
}
function modelOf(agent: Agent): string | null {
  const value = Reflect.get(agent, "model") ?? Reflect.get(agent, "modelId");
  return typeof value === "string" ? value : null;
}

export class ScheduleManager {
  private paseo?: PaseoApi;
  private supported = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private watches = new Map<string, () => void>();
  private quotas = new QuotaCache();
  constructor(readonly accounts: AccountManager, private now: () => number = Date.now) {}
  start(paseo: PaseoApi, supported: boolean) {
    this.paseo = paseo; this.supported = supported;
    if (supported) void this.kick();
  }
  connect(paseo: PaseoApi) { this.paseo ??= paseo; }
  private iso() { return new Date(this.now()).toISOString(); }
  private async context(id: string) {
    if (!this.paseo) throw new AccountError("Paseo에 연결하지 못했습니다.");
    const snapshot = await this.paseo.agents.ref(id).refresh().catch(error => {
      if (error instanceof Error && /^(?:Agent not found:|Unknown agent )/.test(error.message)) throw new AccountError("세션이 삭제되었습니다.");
      throw error;
    });
    if (!snapshot || snapshot.agent.archivedAt) throw new AccountError("세션이 보관되었거나 삭제되었습니다.");
    const agent = snapshot.agent, harness = HarnessSchema.parse(agent.provider), state = await this.accounts.store.read();
    const savedBinding = state.bindings[id], binding = savedBinding?.harness === harness ? savedBinding : undefined;
    const accountId = binding ? binding.accountId : selectedAccount(state, harness, id);
    const account = accountId ? state.accounts.find(a => a.id === accountId && a.harness === harness) : null;
    if (accountId && !account) throw new AccountError("예약에 사용할 계정을 찾지 못했습니다.");
    const adapter = this.accounts.adapters[harness], home = binding?.home ?? (account ? this.accounts.profile(account) : adapter.systemHome);
    return { agent, state, binding, harness, accountId, adapter, home, accountLabel: account?.label ?? "시스템 계정" };
  }
  async list(agentId?: string) {
    const state = await this.accounts.store.read();
    let defaultAt: string | null = null, resetReason: string | null = null, error: string | null = null;
    let context: { harness: "codex" | "claude"; accountLabel: string } | null = null;
    if (agentId && this.paseo) try {
      const c = await this.context(agentId);
      context = { harness: c.harness, accountLabel: c.accountLabel };
      const quota = this.quotas.get(`${c.harness}:${c.accountId ?? "system"}:${c.home}:${c.binding?.identity ?? ""}`, signal => c.adapter.quota(c.home, c.accountId === null, signal));
      const reset = resetFor(quota, modelOf(c.agent), this.now()); defaultAt = reset.at; resetReason = quota.status === "loading" ? "초기화 시각 조회 중…" : reset.reason;
      if (quota.status === "error" || quota.status === "auth-required") error = "한도를 조회하지 못했습니다. 인증·연결을 확인하거나 시간을 직접 지정하세요.";
    } catch { error = "초기화 시각을 조회하지 못했습니다. 시간을 직접 지정하거나 잠시 후 다시 시도하세요."; }
    return { supported: this.supported, jobs: Object.values(state.schedules.jobs).filter(j => !agentId || j.agentId === agentId)
      .sort((a, b) => Number(activeSchedule(b)) - Number(activeSchedule(a)) || (activeSchedule(a) ? a.dueAt.localeCompare(b.dueAt) : b.updatedAt.localeCompare(a.updatedAt))).map(scheduleCard),
      automatic: agentId ? state.schedules.automatic[agentId] ?? false : false, defaultAt, resetReason, context,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, error };
  }
  async change(input: { action: "save"; agentId: string; message: string; dueAt: string } | { action: "cancel"; id: string } | { action: "automatic"; agentId: string; enabled: boolean }) {
    if (input.action === "cancel") {
      const job = (await this.accounts.store.read()).schedules.jobs[input.id];
      if (!job) throw new AccountError("예약을 찾지 못했습니다.");
      if (job.status === "sending") throw new AccountError("전송 결과를 확인 중입니다. 확인 후 변경하세요.");
      if (activeSchedule(job) || job.status === "attention") await this.mark(job, "canceled", "사용자가 예약을 취소했습니다.");
    } else {
      if (!this.supported) throw new AccountError("안전한 예약 전송을 위해 Paseo 호스트 업데이트가 필요합니다.");
      if (input.action === "automatic") {
        await this.context(input.agentId);
        await this.accounts.store.update(s => { s.schedules.automatic[input.agentId] = input.enabled; });
        if (!input.enabled) await this.cancelAgent(input.agentId, "자동 재개를 껐습니다.", true);
      } else {
        if (Date.parse(input.dueAt) <= this.now()) throw new AccountError("현재 시각 이후로 예약하세요.");
        await this.save(input.agentId, input.message, input.dueAt, "manual");
      }
    }
    void this.kick(); return { message: input.action === "cancel" ? "예약을 취소했습니다." : input.action === "automatic" ? "자동 재개 설정을 저장했습니다." : "메시지를 예약했습니다." };
  }
  private async save(id: string, message: string, dueAt: string, source: Schedule["source"], attention?: string) {
    const c = await this.context(id), auth = await c.adapter.status(c.home, c.accountId === null).catch(error => {
      if (source === "manual") throw error;
      return { signedIn: false, identity: c.binding?.identity ?? null };
    });
    if (!auth.signedIn && source === "manual") throw new AccountError("예약하기 전에 선택한 계정에 로그인하세요.");
    const job = await this.accounts.store.update(state => {
      const previous = Object.values(state.schedules.jobs).find(j => j.agentId === id && activeSchedule(j)) ??
        (source === "manual" ? Object.values(state.schedules.jobs).filter(j => j.agentId === id && j.status === "attention").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] : undefined);
      if (previous?.status === "sending") throw new AccountError("전송 결과를 확인 중입니다. 확인 후 변경하세요.");
      if (source === "automatic" && previous) return previous;
      const at = this.iso(), job: Schedule = {
        id: previous?.id ?? randomUUID(), agentId: id, title: c.agent.title || "이름 없는 세션", harness: c.harness,
        accountLabel: c.accountLabel, accountId: c.accountId, identity: auth.identity, generation: c.binding?.generation ?? "",
        sessionId: c.agent.persistence?.sessionId ?? null, lastUserMessageAt: c.agent.lastUserMessageAt ?? null,
        message: message.trim(), dueAt, source, status: attention || !auth.signedIn ? "attention" : "waiting", reason: attention ?? (!auth.signedIn ? "계정 인증을 확인한 후 예약 시간을 지정하세요." : "예약 시각에 작업 종료·한도를 확인한 후 전송합니다."),
        messageId: randomUUID(), revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? at,
        updatedAt: at, nextAttemptAt: null, timelineDirty: true, waitingFor: null, retryAfterSend: false, retryUserMessageAt: null,
      };
      state.schedules.jobs[job.id] = job; return job;
    });
    await this.publish(job);
    return job;
  }
  private async publish(job: Schedule) {
    if (!this.paseo || this.disposed) return;
    try {
      await this.paseo.agents.ref(job.agentId).timeline.append({ type: "plugin", id: job.id, kind: "scheduled-message", version: 1, data: scheduleCard(job) });
      await this.accounts.store.update(s => { const current = s.schedules.jobs[job.id]; if (current?.revision === job.revision && current.updatedAt === job.updatedAt) current.timelineDirty = false; });
    } catch { /* Retry the canonical card on the next daemon tick. The reservation is already durable. */ }
  }
  private async mark(job: Schedule, status: Schedule["status"], reason: string, extra: Partial<Pick<Schedule, "dueAt" | "nextAttemptAt" | "waitingFor">> = {}) {
    const current = await this.accounts.store.update(s => {
      const j = s.schedules.jobs[job.id];
      if (!j || j.revision !== job.revision || !activeSchedule(j) && j.status !== "attention") return null;
      Object.assign(j, { status, reason, updatedAt: this.iso(), timelineDirty: true }, extra); return j;
    });
    if (current) await this.publish(current);
    if (current?.status === "sent" && current.retryAfterSend) {
      await this.accounts.store.update(s => { s.schedules.jobs[current.id].retryAfterSend = false; });
      const c = await this.context(current.agentId).catch(() => null);
      if (c && c.state.schedules.automatic[current.agentId] && c.agent.lastUserMessageAt === current.retryUserMessageAt)
        await this.reserveAutomatic(current.agentId, false);
    }
  }
  async cancelAgent(id: string, reason: string, automaticOnly = false) {
    for (const j of Object.values((await this.accounts.store.read()).schedules.jobs))
      if (j.agentId === id && j.status === "waiting" && (!automaticOnly || j.source === "automatic")) await this.mark(j, "canceled", reason);
  }
  async turnStarted(id: string) { await this.inspectAgent(id); void this.kick(); }
  async inspectAgent(id: string) {
    for (const j of Object.values((await this.accounts.store.read()).schedules.jobs)) if (j.agentId === id && j.status === "waiting") {
      try {
        const c = await this.context(id);
        if (c.agent.lastUserMessageAt !== j.lastUserMessageAt) await this.mark(j, "canceled", "직접 입력한 새 요청을 유지하고 예약을 취소했습니다.");
        else if (this.changed(j, c)) await this.mark(j, "canceled", "실행 계정 또는 세션이 변경되어 예약을 취소했습니다.");
      } catch { /* Transient refresh failures must not cancel a reservation. */ }
    }
  }
  private changed(job: Schedule, c: Awaited<ReturnType<ScheduleManager["context"]>>) {
    return c.harness !== job.harness || c.accountId !== job.accountId || selectedAccount(c.state, c.harness, job.agentId) !== job.accountId ||
      c.binding?.identity && job.identity && c.binding.identity !== job.identity || (c.agent.persistence?.sessionId ?? null) !== job.sessionId;
  }
  async wakeAgent(id: string) {
    await this.accounts.store.update(s => { for (const job of Object.values(s.schedules.jobs))
      if (job.agentId === id && job.status === "waiting" && job.waitingFor) job.nextAttemptAt = null; });
    void this.kick();
  }
  async turnEnded(id: string, event: Parameters<typeof isUsageLimitFailure>[0], turnId: string | null) {
    await this.wakeAgent(id);
    if (!this.supported || !this.paseo || !isUsageLimitFailure(event)) { void this.kick(); return; }
    const state = await this.accounts.store.read(), rotation = state.rotations[id];
    if (!state.schedules.automatic[id] || rotation && ["checking", "switching", "sending", "continued"].includes(rotation.phase)) return;
    const key = state.usage.finished[id] ?? `${state.bindings[id]?.generation ?? ""}:${turnId ?? JSON.stringify(event.outcome)}`;
    const first = await this.accounts.store.update(s => {
      if (s.schedules.lastFailures[id] === key) return false;
      s.schedules.lastFailures[id] = key; return true;
    });
    if (!first) return;
    const previous = Object.values(state.schedules.jobs).find(j => j.agentId === id && activeSchedule(j));
    if (previous?.source === "manual") return;
    if (previous?.status === "sending") {
      const c = await this.context(id);
      await this.accounts.store.update(s => { const j = s.schedules.jobs[previous.id]; j.retryAfterSend = true; j.retryUserMessageAt = c.agent.lastUserMessageAt; });
      return;
    }
    await this.reserveAutomatic(id, event.outcome.kind === "completed");
    void this.kick();
  }
  private async reserveAutomatic(id: string, confirmQuota: boolean) {
    try {
      const c = await this.context(id), quota = await c.adapter.quota(c.home, c.accountId === null), reset = resetFor(quota, modelOf(c.agent), this.now());
      if (confirmQuota && !reset.blocked) return;
      if (reset.at) await this.save(id, "Continue", reset.at, "automatic");
      else await this.save(id, "Continue", this.iso(), "automatic", "초기화 시각을 확인하지 못했습니다. 실행 시간을 직접 지정하세요.");
    } catch {
      await this.save(id, "Continue", this.iso(), "automatic", "계정·사용량을 조회하지 못했습니다. 상태를 확인하고 예약 시간을 직접 지정하세요.").catch(() => {});
    }
  }
  kick(): Promise<void> {
    if (this.disposed || !this.supported || !this.paseo) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    if (this.running) return this.running;
    const run = this.tick().catch(() => {}).finally(() => {
      this.running = undefined;
      if (!this.disposed) void this.arm().catch(() => {});
    });
    this.running = run; return run;
  }
  private async arm() {
    if (this.disposed) return;
    const jobs = Object.values((await this.accounts.store.read()).schedules.jobs).filter(activeSchedule);
    const delay = Math.min(30000, ...jobs.map(j => { const delta = Date.parse(j.nextAttemptAt ?? j.dueAt) - this.now(); return delta > 0 ? delta : 1000; }));
    if (!this.disposed) { this.timer = setTimeout(() => { void this.kick(); }, delay); this.timer.unref?.(); }
  }
  private async tick() {
    const jobs = Object.values((await this.accounts.store.read()).schedules.jobs);
    const agents = new Set(jobs.filter(activeSchedule).map(j => j.agentId));
    for (const [id, stop] of this.watches) if (!agents.has(id)) { stop(); this.watches.delete(id); }
    for (const id of agents) if (!this.watches.has(id)) this.watches.set(id, this.paseo!.agents.ref(id).subscribe(() => { void this.kick(); }));
    for (const job of jobs) {
      if (this.disposed) break;
      if (job.timelineDirty) await this.publish(job);
      if (activeSchedule(job)) await this.accounts.exclusive(() => this.execute(job));
    }
  }
  private async execute(job: Schedule) {
    if (!this.paseo) return;
    const handle = this.paseo.agents.ref(job.agentId);
    if (job.status === "sending") {
      if (job.nextAttemptAt && this.now() < Date.parse(job.nextAttemptAt)) return;
      try {
        const history = await handle.timeline.refetch({ direction: "tail", projection: "canonical", limit: 100 });
        if (history.entries.some(e => e.item.type === "user_message" && (e.item.clientMessageId === job.messageId || e.item.messageId === job.messageId))) {
          await this.mark(job, "sent", "예약 메시지를 전송했습니다."); return;
        }
      } catch (error) {
        if (this.now() > Date.parse(job.dueAt) + DAY || error instanceof Error && /^(?:Agent not found:|Unknown agent )/.test(error.message))
          await this.mark(job, "attention", "세션 또는 전송 결과를 확인하지 못했습니다. 중복 전송을 막기 위해 자동 재전송을 보류했습니다.");
        else await this.mark(job, "sending", "연결이 복구되면 전송 결과를 다시 확인합니다.", { nextAttemptAt: new Date(this.now() + 60000).toISOString() });
        return;
      }
      await this.mark(job, "attention", "전송 결과를 확인하지 못했습니다. 중복 전송을 막기 위해 자동 재전송을 보류했습니다."); return;
    }
    try {
      const c = await this.context(job.agentId);
      if (this.changed(job, c) || c.agent.lastUserMessageAt !== job.lastUserMessageAt) { await this.mark(job, "canceled", "새 요청 또는 계정 변경을 확인해 예약을 취소했습니다."); return; }
      if (this.now() > Date.parse(job.dueAt) + DAY) { await this.mark(job, "attention", "예약 시각이 24시간 이상 지났습니다. 실행 시간을 다시 지정하세요."); return; }
      if (this.now() < Date.parse(job.nextAttemptAt ?? job.dueAt)) return;
      if (c.agent.activeTurn || c.agent.status === "running" || c.agent.status === "initializing" || c.agent.pendingPermissions?.length) {
        await this.mark(job, "waiting", c.agent.pendingPermissions?.length ? "사용자의 권한 승인을 기다리고 있습니다." : "현재 작업이 끝나면 전송합니다.", { nextAttemptAt: new Date(this.now() + 30000).toISOString(), waitingFor: c.agent.pendingPermissions?.length ? "permissions" : "busy" }); return;
      }
      const rotation = c.state.rotations[job.agentId];
      if (c.state.pending[job.agentId] || rotation && ["checking", "switching", "sending"].includes(rotation.phase)) return;
      const auth = await c.adapter.status(c.home, c.accountId === null);
      if (!auth.signedIn) { await this.mark(job, "attention", "계정에 로그인한 후 예약을 다시 지정하세요."); return; }
      if (job.identity && auth.identity !== job.identity) { await this.mark(job, "canceled", "로그인된 실제 계정이 변경되어 예약을 취소했습니다."); return; }
      const quota = await c.adapter.quota(c.home, c.accountId === null);
      if (quota.status === "auth-required") { await this.mark(job, "attention", "계정 인증을 확인한 후 예약을 다시 지정하세요."); return; }
      if (quota.status === "error" || quota.status === "loading") throw new Error("quota-pending");
      const reset = resetFor(quota, modelOf(c.agent), this.now());
      if (reset.blocked) {
        if (reset.stale && this.now() - Date.parse(job.dueAt) < 300000) {
          await this.mark(job, "waiting", "초기화 시각이 지났습니다. 서비스의 한도 갱신을 기다리고 있습니다.", { nextAttemptAt: new Date(this.now() + 30000).toISOString() }); return;
        }
        await this.mark(job, reset.at ? "waiting" : "attention", reset.reason, reset.at ? { dueAt: reset.at, nextAttemptAt: null } : {}); return;
      }
      const claimed = await this.accounts.store.update(s => {
        const current = s.schedules.jobs[job.id];
        if (this.disposed || current?.status !== "waiting" || current.revision !== job.revision || current.messageId !== job.messageId) return false;
        const binding = s.bindings[job.agentId];
        if (selectedAccount(s, job.harness, job.agentId) !== job.accountId || binding && (binding.accountId !== job.accountId || binding.harness !== job.harness)) return "changed";
        if (s.pending[job.agentId] || ["checking", "switching", "sending"].includes(s.rotations[job.agentId]?.phase)) return "blocked";
        Object.assign(current, { status: "sending", reason: "예약 메시지의 전송 결과를 확인하고 있습니다.", updatedAt: this.iso(), timelineDirty: true, waitingFor: null }); return true;
      });
      if (claimed === "changed") { await this.mark(job, "canceled", "실행 계정이 변경되어 예약을 취소했습니다."); return; }
      if (claimed === "blocked") { await this.mark(job, "waiting", "계정 전환이 끝나면 예약 상태를 다시 확인합니다.", { nextAttemptAt: new Date(this.now() + 30000).toISOString() }); return; }
      if (!claimed || this.disposed) return;
      const options = { messageId: job.messageId, sendGuard: { lastUserMessageAt: job.lastUserMessageAt, provider: job.harness, ...(job.sessionId ? { sessionId: job.sessionId } : {}) } };
      try {
        await handle.send(job.message, options);
        await this.mark(job, "sent", "예약 메시지를 전송했습니다.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("SCHEDULE_GUARD_BUSY")) await this.mark(job, "waiting", "현재 작업 또는 권한 승인이 끝나면 전송합니다.", { nextAttemptAt: new Date(this.now() + 30000).toISOString(), waitingFor: "busy" });
        else if (/SCHEDULE_GUARD_CHANGED|SCHEDULE_GUARD_ARCHIVED/.test(message)) await this.mark(job, "canceled", "세션 상태가 변경되어 예약을 취소했습니다.");
        // An unknown acknowledgement stays 'sending' until its canonical receipt is reconciled.
      }
    } catch (error) {
      if (error instanceof AccountError && /보관|삭제|찾지/.test(error.message)) await this.mark(job, "canceled", "세션 또는 계정이 삭제·보관되어 예약을 취소했습니다.");
      else if (error instanceof QuotaError && error.status === "auth-required") await this.mark(job, "attention", "계정 인증을 확인한 후 예약을 다시 지정하세요.");
      else await this.mark(job, "waiting", "연결·사용량 조회를 다시 확인하고 있습니다.", { nextAttemptAt: new Date(this.now() + 60000).toISOString() });
    }
  }
  dispose() {
    this.disposed = true; this.quotas.stop(); if (this.timer) clearTimeout(this.timer);
    for (const stop of this.watches.values()) stop(); this.watches.clear();
  }
}
