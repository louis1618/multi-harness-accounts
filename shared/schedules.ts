import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ScheduleStatus = z.enum(["waiting", "sending", "sent", "canceled", "attention"]);
export const scheduleRetentionMs = 30 * 86400000;
export const scheduleSupportMessage = "예약 전송용 안전 확장이 이 호스트에 적용되지 않았습니다. 확장 적용 후 호스트 재시작이 필요합니다.";
export const scheduleLabels: Record<z.infer<typeof ScheduleStatus>, string> = {
  waiting: "예약 중", sending: "전송 확인 중", sent: "전송 완료", canceled: "취소됨", attention: "확인 필요",
};
export const ScheduleCardSchema = z.object({
  id: z.string().uuid(), agentId: z.string().min(1).max(128), title: z.string(),
  harness: z.enum(["codex", "claude"]), accountLabel: z.string(), message: z.string().trim().min(1).max(16000),
  dueAt: z.string().datetime(), status: ScheduleStatus, reason: z.string(),
  source: z.enum(["manual", "automatic"]), updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable().default(null),
  waitingFor: z.enum(["busy", "permissions", "quota"]).nullable().optional(),
}).strict();
export const ScheduleSchema = ScheduleCardSchema.extend({
  accountId: z.string().uuid().nullable(), identity: z.string().nullable(), generation: z.string(),
  sessionId: z.string().nullable(), lastUserMessageAt: z.string().nullable(),
  messageId: z.string().uuid(), revision: z.number().int().positive(), createdAt: z.string().datetime(),
  nextAttemptAt: z.string().datetime().nullable(), timelineDirty: z.boolean(),
  waitingFor: z.enum(["busy", "permissions", "quota"]).nullable().default(null),
  retryAfterSend: z.boolean().default(false), retryUserMessageAt: z.string().nullable().default(null),
}).strict();
export type Schedule = z.infer<typeof ScheduleSchema>;
export type ScheduleCard = z.infer<typeof ScheduleCardSchema>;
export const ScheduleTimelineSchema = z.union([ScheduleCardSchema, z.object({ id: z.string().uuid(), deleted: z.literal(true) }).strict()]);
export type ScheduleTimeline = z.infer<typeof ScheduleTimelineSchema>;
export const ScheduleStateSchema = z.object({
  jobs: z.record(z.string().uuid(), ScheduleSchema).default({}),
  removed: z.record(z.string().uuid(), z.string().min(1).max(128)).default({}),
  automatic: z.record(z.string(), z.boolean()).default({}),
  lastFailures: z.record(z.string(), z.string()).default({}),
}).strict().default({ jobs: {}, removed: {}, automatic: {}, lastFailures: {} });
export const activeSchedule = (job: Pick<Schedule, "status">) => job.status === "waiting" || job.status === "sending";
export const finishedSchedule = (job: Pick<Schedule, "status">) => job.status === "sent" || job.status === "canceled";
export const scheduleCard = (job: Schedule): ScheduleCard => ScheduleCardSchema.parse({
  id: job.id, agentId: job.agentId, title: job.title, harness: job.harness, accountLabel: job.accountLabel,
  message: job.message, dueAt: job.dueAt, status: job.status, reason: job.reason, source: job.source, updatedAt: job.updatedAt, finishedAt: job.finishedAt, waitingFor: job.waitingFor,
});
const AgentId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const listSchedules = defineRpc({ name: "accounts.schedules.list", input: z.object({ agentId: AgentId.optional(), refresh: z.boolean().optional() }).strict(),
  output: z.object({ supported: z.boolean(), jobs: z.array(ScheduleCardSchema), automatic: z.boolean(),
    context: z.object({ harness: ScheduleCardSchema.shape.harness, accountLabel: z.string() }).strict().nullable().default(null),
    defaultAt: z.string().datetime().nullable(), resetReason: z.string().nullable(), timezone: z.string(), error: z.string().nullable(),
    retryAt: z.string().datetime().nullable().default(null), quotaFetchedAt: z.string().datetime().nullable().default(null),
    attemptedAt: z.string().datetime().nullable().default(null), retrySource: z.enum(["server", "local"]).nullable().default(null) }).strict() });
export const changeSchedule = defineRpc({ name: "accounts.schedules.change", input: z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), agentId: AgentId, message: ScheduleCardSchema.shape.message, dueAt: z.string().datetime() }).strict(),
  z.object({ action: z.literal("cancel"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("automatic"), agentId: AgentId, enabled: z.boolean() }).strict(),
]), output: z.object({ message: z.string() }).strict() });

export function localDateTime(value: string): { date: string; time: string } {
  const d = new Date(value), pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` };
}
export function parseLocalDateTime(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) return null;
  const parsed = new Date(`${date}T${time.length === 5 ? `${time}:00` : time}`);
  if (!Number.isFinite(parsed.getTime())) return null;
  const roundtrip = localDateTime(parsed.toISOString());
  return roundtrip.date === date && roundtrip.time === (time.length === 5 ? `${time}:00` : time) ? parsed.toISOString() : null;
}
