import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(4096)
  .refine((x) => !/[\0\r\n]/.test(x));
export const ActionSchema = z.enum([
  "thumbnails",
  "apt-autoclean",
  "journal-vacuum",
  "image-remove",
  "network-remove",
  "build-cache",
  "process-stop",
  "container-start",
  "container-stop",
  "container-restart",
  "compose-start",
  "compose-stop",
  "compose-restart",
]);
export type Action = z.infer<typeof ActionSchema>;
export const RequestSchema = z
  .object({ action: ActionSchema, target: id })
  .strict();
export type Request = z.infer<typeof RequestSchema>;
export const CandidateSchema = z.object({
  id,
  action: ActionSchema,
  title: z.string(),
  bytes: z.number().nullable(),
  eligible: z.boolean(),
  reason: z.string(),
  impact: z.string(),
  admin: z.boolean(),
  fingerprint: z.string(),
});
export type Candidate = z.infer<typeof CandidateSchema>;
export const ProcessSchema = z.object({
  id,
  name: z.string(),
  pids: z.array(z.number()),
  cpu: z.number().nullable(),
  rss: z.number(),
  ageSeconds: z.number(),
  service: z.string().nullable(),
  container: z.string().nullable(),
  protected: z.boolean(),
  reason: z.string(),
  fingerprint: z.string(),
});
export type Program = z.infer<typeof ProcessSchema>;
export const DockerSchema = z.object({
  available: z.boolean(),
  error: z.string().nullable(),
  identity: z.string(),
  socket: z.string(),
  containers: z.array(
    z.object({
      id,
      name: z.string(),
      image: z.string(),
      state: z.string(),
      status: z.string(),
      project: z.string().nullable(),
      cpu: z.number().nullable(),
      memory: z.number().nullable(),
      writableBytes: z.number().nullable(),
      volumes: z.array(z.string()),
      networks: z.array(z.string()),
      fingerprint: z.string(),
    }),
  ),
  images: z.array(
    z.object({
      id,
      tags: z.array(z.string()),
      size: z.number(),
      uniqueSize: z.number().nullable(),
      references: z.array(z.string()),
      protected: z.boolean(),
      reason: z.string(),
      fingerprint: z.string(),
    }),
  ),
  volumes: z.array(
    z.object({
      name: z.string(),
      driver: z.string(),
      references: z.array(z.string()),
      bytes: z.number().nullable(),
    }),
  ),
  networks: z.array(
    z.object({
      id,
      name: z.string(),
      driver: z.string(),
      references: z.array(z.string()),
      protected: z.boolean(),
      reason: z.string(),
      fingerprint: z.string(),
    }),
  ),
  stacks: z.array(
    z.object({
      name: z.string(),
      containers: z.array(z.string()),
      files: z.array(z.string()),
      readable: z.boolean(),
      fingerprint: z.string(),
    }),
  ),
  usage: z.object({
    imageBytes: z.number().nullable(),
    imageReclaimable: z.number().nullable(),
    volumeBytes: z.number().nullable(),
    containerBytes: z.number().nullable(),
    buildBytes: z.number().nullable(),
  }),
  composeComplete: z.boolean(),
  warnings: z.array(z.string()),
});
export type DockerData = z.infer<typeof DockerSchema>;
export const SettingsSchema = z
  .object({
    analysisMinutes: z.number().int().min(30).max(1440).default(30),
    composeFiles: z.array(id).max(50).default([]),
    protectedImages: z.array(id).max(100).default([]),
    protectedNetworks: z.array(id).max(100).default([]),
    protectedPrograms: z.array(id).max(100).default([]),
    protectedContainers: z.array(id).max(100).default([]),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export const StepSchema = z.object({
  request: RequestSchema,
  title: z.string(),
  impact: z.string(),
  bytes: z.number().nullable(),
  admin: z.boolean(),
  status: z.enum([
    "pending",
    "running",
    "done",
    "skipped",
    "error",
    "canceled",
  ]),
  message: z.string().nullable(),
});
export const JobSchema = z.object({
  id,
  status: z.enum([
    "waiting",
    "running",
    "done",
    "partial",
    "error",
    "interrupted",
    "canceled",
  ]),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  reclaimedBytes: z.number().nullable(),
  steps: z.array(StepSchema),
});
export type Job = z.infer<typeof JobSchema>;
export const AnalysisSchema = z.object({
  status: z.enum(["idle", "running", "done", "partial", "canceled", "error"]),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  areas: z.array(
    z.object({
      path: z.string(),
      bytes: z.number().nullable(),
      status: z.enum(["measured", "partial", "unavailable"]),
    }),
  ),
  warnings: z.array(z.string()),
  candidates: z.array(CandidateSchema),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
export const snapshotRpc = defineRpc({
  name: "care.snapshot",
  input: z.object({ docker: z.boolean().default(false) }),
  output: z.object({
    sampledAt: z.string(),
    cpu: z.number().nullable(),
    memory: z.object({
      total: z.number(),
      available: z.number(),
      swapTotal: z.number(),
      swapUsed: z.number(),
    }),
    disks: z.array(
      z.object({
        mount: z.string(),
        device: z.string(),
        total: z.number(),
        available: z.number(),
        used: z.number(),
      }),
    ),
    programs: z.array(ProcessSchema),
    docker: DockerSchema.nullable(),
    analysis: AnalysisSchema,
    jobs: z.array(JobSchema),
    settings: SettingsSchema,
    helper: z.object({ installed: z.boolean(), message: z.string() }),
    warnings: z.array(z.string()),
  }),
});
export const scanRpc = defineRpc({
  name: "care.scan",
  input: z.object({ cancel: z.boolean().default(false) }),
  output: AnalysisSchema,
});
export const previewRpc = defineRpc({
  name: "care.preview",
  input: z.object({ requests: z.array(RequestSchema).min(1).max(100) }),
  output: z.object({
    id: z.string().uuid(),
    expiresAt: z.string(),
    steps: z.array(StepSchema),
    excluded: z.array(z.object({ request: RequestSchema, reason: z.string() })),
  }),
});
export const executeRpc = defineRpc({
  name: "care.execute",
  input: z.object({ id: z.string().uuid(), confirmed: z.literal(true) }),
  output: JobSchema,
});
export const autoCleanRpc = defineRpc({
  name: "care.auto-preview",
  input: z.object({}).strict(),
  output: previewRpc.output,
});
export const jobsRpc = defineRpc({
  name: "care.jobs",
  input: z.object({ cancel: z.string().uuid().optional() }),
  output: z.object({ jobs: z.array(JobSchema) }),
});
export const settingsRpc = defineRpc({
  name: "care.settings",
  input: z.object({ settings: SettingsSchema.optional() }),
  output: SettingsSchema,
});
export const logsRpc = defineRpc({
  name: "care.logs",
  input: z.object({ id, tail: z.number().int().min(10).max(200).default(100) }),
  output: z.object({ text: z.string(), truncated: z.boolean() }),
});
export const helperRpc = defineRpc({
  name: "care.helper-setup",
  input: z.object({ confirmed: z.literal(true) }),
  output: z.object({ message: z.string() }),
});
export function bytes(n: number | null) {
  if (n === null) return "미조회";
  if (n === 0) return "0 B";
  const i = Math.min(4, Math.max(0, Math.floor(Math.log(n) / Math.log(1024))));
  return `${(n / 1024 ** i).toLocaleString("ko-KR", { maximumFractionDigits: 1 })} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
