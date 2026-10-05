import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ScheduleStateSchema } from "./schedules.js";

export const HarnessSchema = z.enum(["codex", "claude"]);
export type Harness = z.infer<typeof HarnessSchema>;
export const harnessLabels: Record<Harness, string> = { codex: "Codex", claude: "Claude Code" };
export function formatResetCountdown(value: string | null, now = Date.now()): string {
  const resetAt = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(resetAt)) return "초기화 시각 미제공";
  if (resetAt <= now) return "초기화 시각 지남 · 갱신 대기";
  const minutes = Math.floor((resetAt - now) / 60000);
  if (minutes === 0) return "1분 미만 후";
  return [[Math.floor(minutes / 1440), "일"], [Math.floor(minutes % 1440 / 60), "시간"], [minutes % 60, "분"]]
    .filter(([count]) => Number(count) > 0).map(([count, unit]) => `${count}${unit}`).join(" ") + " 후";
}
export const AccountIdSchema = z.string().uuid();
const AgentIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const AccountSchema = z.object({
  id: AccountIdSchema, harness: HarnessSchema, label: z.string().trim().min(1).max(80),
  createdAt: z.string().datetime(),
}).strict();
export type Account = z.infer<typeof AccountSchema>;
export const TokenTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(), cacheWriteInputTokens: z.number().int().nonnegative(),
}).strict();
export type TokenTotals = z.infer<typeof TokenTotalsSchema>;
export const emptyTokens = (): TokenTotals => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
export const ResetOutcomeSchema = z.enum(["reset", "alreadyRedeemed", "nothingToReset", "noCredit", "cooldown", "rateLimited", "authRequired", "unavailable"]);
export type ResetOutcome = z.infer<typeof ResetOutcomeSchema>;
export const QuotaSchema = z.object({
  status: z.enum(["loading", "available", "unavailable", "auth-required", "error"]),
  plan: z.string().nullable(), fetchedAt: z.string().datetime().nullable(), error: z.string().nullable(),
  retryAt: z.string().datetime().nullable().optional(),
  attemptedAt: z.string().datetime().nullable().optional(),
  retrySource: z.enum(["server", "local"]).nullable().optional(),
  failureCode: z.enum(["rate-limited", "network", "response", "profile", "auth", "unknown"]).nullable().optional(),
  windows: z.array(z.object({
    id: z.string(), label: z.string(), usedPercent: z.number().min(0).max(100),
    durationMinutes: z.number().positive(), resetsAt: z.string().datetime().nullable(),
    scope: z.string().nullable().optional(),
  }).strict()),
  resetError: z.string().nullable().optional(),
  resetCredits: z.object({
    eligible: z.boolean().optional(), reason: z.string().nullable().optional(),
    availableCount: z.number().int().nonnegative(),
    credits: z.array(z.object({
      id: z.string().min(1).max(512), resetType: z.string(), status: z.string(),
      grantedAt: z.string().datetime().nullable(), expiresAt: z.string().datetime().nullable(),
      title: z.string().nullable(),
      remaining: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional(),
      clears: z.array(z.string()).optional(), blockedReason: z.string().nullable().optional(),
    }).strict()).nullable(),
  }).strict().nullable().default(null),
}).strict();
export type Quota = z.infer<typeof QuotaSchema>;
export const StatisticsSchema = TokenTotalsSchema.extend({
  totalTokens: z.number().int().nonnegative(), turns: z.number().int().nonnegative(),
  incompleteTurns: z.number().int().nonnegative(), available: z.boolean(),
  startedAt: z.string().datetime(), lastUsedAt: z.string().datetime().nullable(),
}).strict();
const MetricsSchema = z.object({ quota: QuotaSchema, statistics: StatisticsSchema, isMostRecent: z.boolean(),
  sharedStatisticsWith: z.string().nullable().default(null) }).strict();
export type Metrics = z.infer<typeof MetricsSchema>;
const CounterSchema = z.object({
  totals: TokenTotalsSchema, observed: z.boolean(), complete: z.boolean(),
}).strict();
export type UsageCounter = z.infer<typeof CounterSchema>;
const RotationSettingsSchema = z.object({ codex: z.boolean(), claude: z.boolean() }).strict().default({ codex: false, claude: false });
const RotationPhaseSchema = z.enum(["checking", "switching", "sending", "continued", "completed", "stopped", "error"]);
export const StateSchema = z.object({
  version: z.literal(3).default(3),
  schedules: ScheduleStateSchema,
  historyRecovery: z.record(AgentIdSchema, z.object({ sessionId: z.string(), status: z.enum(["recovered", "blocked"]), message: z.string(), updatedAt: z.string().datetime() }).strict()).default({}),
  accounts: z.array(AccountSchema).default([]),
  defaults: z.object({ codex: AccountIdSchema.nullable(), claude: AccountIdSchema.nullable() })
    .default({ codex: null, claude: null }),
  rotation: RotationSettingsSchema,
  rotations: z.record(AgentIdSchema, z.object({
    harness: HarnessSchema, sessionId: z.string(), failedKey: z.string(), phase: RotationPhaseSchema,
    fromAccountId: AccountIdSchema.nullable(), targetAccountId: AccountIdSchema.nullable(),
    originalOverride: z.union([AccountIdSchema, z.literal("inherit"), z.null()]),
    triedRows: z.array(z.string()), triedIdentities: z.array(z.string()), messageId: z.string().uuid(),
    lastUserMessageAt: z.string().nullable(), updatedAt: z.string().datetime(), message: z.string(),
  }).strict()).default({}),
  overrides: z.record(AgentIdSchema, AccountIdSchema.nullable()).default({}),
  bindings: z.record(AgentIdSchema, z.object({
    harness: HarnessSchema, accountId: AccountIdSchema.nullable(), home: z.string().min(1),
    sessionId: z.string().nullable(),
    identity: z.string().nullable().default(null),
    generation: z.string().default(""),
  }).strict()).default({}),
  pending: z.record(AgentIdSchema, z.object({ error: z.string().nullable(), rotationKey: z.string().optional() }).strict()).default({}),
  resetAttempts: z.record(z.string(), z.object({
    id: z.string().uuid(), accountId: AccountIdSchema.nullable(), identity: z.string(), harness: HarnessSchema.default("codex"),
    createdAt: z.string().datetime(), stage: z.enum(["prepared", "pending", "complete"]),
    creditId: z.string().nullable(), outcome: z.string().nullable(), submittedAt: z.string().datetime().nullable().default(null),
  }).strict()).default({}),
  usage: z.object({
    startedAt: z.string().datetime(),
    identities: z.record(z.string(), z.string()).default({}),
    totals: z.record(z.string(), TokenTotalsSchema.extend({
      turns: z.number().int().nonnegative(), incompleteTurns: z.number().int().nonnegative(),
      lastUsedAt: z.string().datetime().nullable(),
    }).strict()).default({}),
    checkpoints: z.record(z.string(), CounterSchema).default({}),
    prepared: z.record(AgentIdSchema, z.object({ sessionId: z.string().nullable(), baseline: CounterSchema }).strict()).default({}),
    finished: z.record(AgentIdSchema, z.string()).default({}),
    active: z.record(AgentIdSchema, z.object({
      key: z.string(), turnId: z.string().nullable().default(null), row: z.string(), identity: z.string().nullable(), harness: HarnessSchema,
      home: z.string(), native: z.boolean(), sessionId: z.string().nullable(),
      startedAt: z.string().datetime(), baseline: CounterSchema.nullable(), lastUserMessageAt: z.string().nullable().default(null),
    }).strict()).default({}),
    mostRecentRow: z.string().nullable().default(null),
    mostRecentIdentity: z.string().nullable().default(null),
    mostRecentAt: z.string().datetime().nullable().default(null),
  }).strict().default(() => ({ startedAt: new Date().toISOString(), identities: {}, totals: {}, checkpoints: {}, prepared: {}, finished: {}, active: {}, mostRecentRow: null, mostRecentIdentity: null, mostRecentAt: null })),
}).strict().superRefine((state, context) => {
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  if (accounts.size !== state.accounts.length) context.addIssue({ code: "custom", message: "계정 ID가 중복되었습니다." });
  for (const harness of ["codex", "claude"] as const) {
    const id = state.defaults[harness];
    if (id && accounts.get(id)?.harness !== harness) context.addIssue({ code: "custom", message: "기본 계정이 올바르지 않습니다." });
  }
  for (const id of Object.values(state.overrides)) {
    if (id && !accounts.has(id)) context.addIssue({ code: "custom", message: "지정된 계정을 찾을 수 없습니다." });
  }
});
export type State = z.infer<typeof StateSchema>;
export const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), harness: HarnessSchema, label: AccountSchema.shape.label }).strict(),
  z.object({ action: z.literal("relogin"), id: AccountIdSchema }).strict(),
  z.object({ action: z.literal("remove"), id: AccountIdSchema }).strict(),
  z.object({ action: z.literal("cancel-login"), id: AccountIdSchema }).strict(),
  z.object({ action: z.literal("open-login-browser"), harness: HarnessSchema, accountId: AccountIdSchema.nullable() }).strict(),
  z.object({ action: z.literal("select"), harness: HarnessSchema, accountId: AccountIdSchema.nullable(), agentId: AgentIdSchema.optional() }).strict(),
  z.object({ action: z.literal("inherit"), agentId: AgentIdSchema }).strict(),
  z.object({ action: z.literal("retry"), agentId: AgentIdSchema }).strict(),
  z.object({ action: z.literal("refresh-usage") }).strict(),
  z.object({ action: z.literal("set-rotation"), harness: HarnessSchema, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("retry-rotation"), agentId: AgentIdSchema }).strict(),
  z.object({ action: z.literal("relogin-system"), harness: HarnessSchema, confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("logout-system"), harness: HarnessSchema, confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal("cancel-system-login"), harness: HarnessSchema }).strict(),
]);
export type Action = z.infer<typeof ActionSchema>;
export const SnapshotSchema = z.object({
  systemAccounts: z.array(z.object({
    harness: HarnessSchema, status: z.enum(["signed-in", "signed-out", "authenticating", "error"]),
    email: z.string().nullable(), error: z.string().nullable(), authUrl: z.string().max(16384).nullable().default(null),
    metrics: MetricsSchema,
  }).strict()),
  accounts: z.array(AccountSchema.extend({
    status: z.enum(["signed-in", "signed-out", "authenticating", "error"]),
    email: z.string().nullable(), error: z.string().nullable(), authUrl: z.string().max(16384).nullable().default(null),
    metrics: MetricsSchema,
  }).strict()),
  defaults: StateSchema.shape.defaults,
  rotation: RotationSettingsSchema,
  summary: StatisticsSchema.extend({ accountCount: z.number().int().nonnegative() }).strict(),
  agents: z.array(z.object({
    id: AgentIdSchema, title: z.string(), harness: HarnessSchema, status: z.string(),
    override: z.union([AccountIdSchema, z.literal("inherit"), z.literal("system")]),
    desiredAccountId: AccountIdSchema.nullable(), currentAccountId: AccountIdSchema.nullable(),
    pending: z.boolean(), error: z.string().nullable(),
    rotation: z.object({ phase: RotationPhaseSchema, message: z.string(), updatedAt: z.string().datetime() }).strict().nullable().default(null),
  }).strict()),
}).strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const listAccounts = defineRpc({ name: "accounts.list", input: z.object({}).strict(), output: SnapshotSchema });
export const changeAccount = defineRpc({ name: "accounts.change", input: ActionSchema, output: z.object({ message: z.string() }).strict() });
export const SessionSchema = z.object({
  id: z.string().min(1).max(512), harness: HarnessSchema, title: z.string().max(240), cwd: z.string(),
  updatedAt: z.string().datetime().nullable(), source: z.enum(["paseo", "native"]),
  agentId: AgentIdSchema.nullable(), accountId: AccountIdSchema.nullable(),
  nativeSessionId: z.string().max(128).nullable(),
}).strict();
export type AccountSession = z.infer<typeof SessionSchema>;
export const listSessions = defineRpc({ name: "accounts.sessions", input: z.object({ refresh: z.boolean().optional() }).strict(),
  output: z.object({ sessions: z.array(SessionSchema), warnings: z.array(z.string()) }).strict() });
export const importAccountSession = defineRpc({ name: "accounts.import-session",
  input: z.object({ id: SessionSchema.shape.id }).strict(),
  output: z.object({ agentId: AgentIdSchema, message: z.string() }).strict() });
export const prepareReset = defineRpc({ name: "accounts.prepare-reset",
  input: z.object({ accountId: AccountIdSchema.nullable(), harness: HarnessSchema.default("codex") }).strict(),
  output: z.object({ attemptId: z.string().uuid(), quota: QuotaSchema, pending: z.boolean(), creditId: z.string().nullable() }).strict() });
export const consumeReset = defineRpc({ name: "accounts.consume-reset",
  input: z.object({ attemptId: z.string().uuid(), creditId: z.string().min(1).max(512).nullable(), confirmed: z.literal(true) }).strict(),
  output: z.object({ outcome: ResetOutcomeSchema, message: z.string() }).strict() });
