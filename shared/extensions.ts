import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { HarnessSchema, AccountIdSchema } from "./accounts.js";
export const TargetSchema = z
  .object({
    harness: HarnessSchema,
    accountId: AccountIdSchema.nullable(),
    scope: z.enum(["user", "project", "local"]).default("user"),
    sessionId: z.string().max(512).nullable().default(null),
  })
  .strict();
export type Target = z.infer<typeof TargetSchema>;
export const KindSchema = z.enum(["plugin", "skill", "marketplace", "mcp"]);
export type Kind = z.infer<typeof KindSchema>;
export const ItemSchema = z
  .object({
    key: z.string(),
    kind: KindSchema,
    name: z.string(),
    version: z.string().nullable(),
    enabled: z.boolean(),
    scope: z.string(),
    source: z.string().nullable(),
    editable: z.boolean(),
    authNeeded: z.boolean(),
    components: z.array(z.string()),
    fingerprint: z.string(),
    common: z.boolean(),
  })
  .strict();
export type ExtensionItem = z.infer<typeof ItemSchema>;
const StepSchema = z
  .object({
    target: TargetSchema,
    key: z.string(),
    name: z.string(),
    kind: KindSchema,
    action: z.enum([
      "add",
      "update",
      "repair",
      "remove",
      "enable",
      "disable",
      "configure",
      "skip",
      "conflict",
      "restore",
    ]),
    status: z.enum([
      "pending",
      "waiting",
      "running",
      "done",
      "error",
      "approval",
      "skipped",
    ]),
    message: z.string().nullable(),
    command: z.string().nullable().default(null),
    approvalHash: z.string().nullable().default(null),
    backupId: z.string().uuid().nullable().default(null),
  })
  .strict();
export const JobSchema = z
  .object({
    id: z.string(),
    status: z.enum([
      "waiting",
      "running",
      "done",
      "error",
      "canceled",
      "approval",
    ]),
    createdAt: z.string(),
    steps: z.array(StepSchema),
  })
  .strict();
export type ExtensionJob = z.infer<typeof JobSchema>;
export const inventoryExtensions = defineRpc({
  name: "extensions.inventory",
  input: TargetSchema,
  output: z
    .object({
      items: z.array(ItemSchema),
      common: z.array(ItemSchema),
      warnings: z.array(z.string()),
      version: z.string(),
      autoNew: z.boolean(),
      autoSwitch: z.boolean(),
      jobs: z.array(JobSchema),
    })
    .strict(),
});
export const commonExtensions = defineRpc({
  name: "extensions.common",
  input: z
    .object({
      target: TargetSchema,
      keys: z.array(z.string()).max(200),
      remove: z.boolean().default(false),
      autoNew: z.boolean().optional(),
      autoSwitch: z.boolean().optional(),
    })
    .strict(),
  output: z.object({ message: z.string() }),
});
export const previewExtensions = defineRpc({
  name: "extensions.preview",
  input: z
    .object({
      targets: z.array(TargetSchema).min(1).max(100),
      keys: z.array(z.string()).max(200).optional(),
    })
    .strict(),
  output: z.object({ id: z.string(), steps: z.array(StepSchema) }),
});
export const applyExtensions = defineRpc({
  name: "extensions.apply",
  input: z
    .object({
      id: z.string().uuid(),
      replace: z.array(z.string()).max(200).default([]),
      confirmed: z.literal(true),
    })
    .strict(),
  output: z.object({ job: JobSchema }),
});
export const mutateExtension = defineRpc({
  name: "extensions.mutate",
  input: z
    .object({
      target: TargetSchema,
      kind: KindSchema,
      name: z.string().trim().min(1).max(200),
      action: z.enum([
        "install",
        "update",
        "remove",
        "enable",
        "disable",
        "configure",
        "edit",
        "authenticate",
      ]),
      value: z.string().max(100000).optional(),
      confirmed: z.literal(true),
    })
    .strict(),
  output: z.object({ job: JobSchema }),
});
export const extensionDetails = defineRpc({
  name: "extensions.details",
  input: z.object({ target: TargetSchema, key: z.string() }).strict(),
  output: z.object({ text: z.string(), editable: z.boolean() }),
});
export const extensionJobs = defineRpc({
  name: "extensions.jobs",
  input: z
    .object({
      cancel: z.string().uuid().optional(),
      retry: z.string().uuid().optional(),
      restore: z
        .object({
          id: z.string().uuid(),
          index: z.number().int().min(0),
          confirmed: z.literal(true),
        })
        .optional(),
      approve: z
        .object({
          id: z.string().uuid(),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .optional(),
    })
    .strict(),
  output: z.object({ jobs: z.array(JobSchema) }),
});
