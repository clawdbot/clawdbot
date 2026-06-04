import { z } from "zod";

const RuntimeLocalitySchema = z.enum(["local", "remote", "cloud", "unknown"]);
const RuntimeActionKindSchema = z.enum([
  "scale_up",
  "scale_down",
  "delegate",
  "provision",
  "open_session",
  "submit_task",
]);

const RuntimeActionRefSchema = z
  .object({
    kind: RuntimeActionKindSchema,
    label: z.string().min(1),
    ref: z.string().min(1),
    requiresApproval: z.boolean().optional(),
    validUntil: z.string().optional(),
    providerId: z.string().optional(),
  })
  .strict();

const RuntimeResourcesSchema = z
  .object({
    cpu: z
      .object({
        architecture: z.string().optional(),
        effectiveCores: z.number().positive().optional(),
        model: z.string().optional(),
        features: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    memory: z
      .object({
        effectiveBytes: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    disk: z
      .object({
        effectiveBytes: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    accelerators: z
      .array(
        z
          .object({
            kind: z.enum(["gpu", "npu", "tpu", "other"]),
            vendor: z.string().optional(),
            model: z.string().optional(),
            memoryBytes: z.number().nonnegative().optional(),
            runtimes: z
              .array(
                z.enum([
                  "cuda",
                  "rocm",
                  "metal",
                  "opencl",
                  "vulkan",
                  "sycl",
                  "level-zero",
                  "unknown",
                ]),
              )
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const RuntimeLimitsSchema = z
  .object({
    maxTaskSeconds: z.number().positive().optional(),
    secretsAllowed: z.boolean().optional(),
    networkAccess: z.enum(["enabled", "disabled", "restricted", "unknown"]).optional(),
    filesystemAccess: z.enum(["full", "workspace", "read_only", "none", "unknown"]).optional(),
    approvalRequiredFor: z.array(RuntimeActionKindSchema).optional(),
  })
  .strict();

const RuntimeCostHintSchema = z
  .object({
    model: z.enum(["free", "included", "metered", "quota", "unknown"]),
    currency: z.string().optional(),
    roughUnitCost: z.string().optional(),
    quotaRemaining: z.string().optional(),
    estimateRef: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict();

const RuntimeFreshnessSchema = z
  .object({
    observedAt: z.string().optional(),
    validUntil: z.string().optional(),
    ttlSeconds: z.number().positive().optional(),
    stale: z.boolean().optional(),
  })
  .strict();

const RuntimeProvenanceSchema = z
  .object({
    source: z.enum(["static_config", "provider", "probe", "operator", "mixed"]).optional(),
    providerId: z.string().optional(),
  })
  .strict();

const RuntimeWorkspaceSchema = z
  .object({
    mode: z.enum(["local", "mounted", "synced", "remote", "none", "unknown"]).optional(),
    writable: z.boolean().optional(),
    cwdRelative: z.string().optional(),
  })
  .strict();

const RuntimeCurrentSchema = z
  .object({
    id: z.string().optional(),
    label: z.string().optional(),
    locality: RuntimeLocalitySchema.optional(),
    environmentId: z.string().optional(),
    workspace: RuntimeWorkspaceSchema.optional(),
  })
  .strict();

const RuntimeOffloadTargetSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    locality: RuntimeLocalitySchema.optional(),
    workloadKinds: z
      .array(
        z.enum(["codex", "shell", "build", "test", "long_task", "gpu_compute", "media", "generic"]),
      )
      .optional(),
    resources: RuntimeResourcesSchema.optional(),
    limits: RuntimeLimitsSchema.optional(),
    availability: z
      .object({
        state: z
          .enum(["available", "unavailable", "starting", "stopping", "error", "unknown"])
          .optional(),
        reason: z.string().optional(),
      })
      .strict()
      .optional(),
    actions: z
      .object({
        submitTask: RuntimeActionRefSchema.optional(),
        openSession: RuntimeActionRefSchema.optional(),
        provision: RuntimeActionRefSchema.optional(),
      })
      .strict()
      .optional(),
    cost: RuntimeCostHintSchema.optional(),
    validUntil: z.string().optional(),
    providerId: z.string().optional(),
  })
  .strict();

const RuntimeSelfContextSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    current: RuntimeCurrentSchema.optional(),
    resources: RuntimeResourcesSchema.optional(),
    limits: RuntimeLimitsSchema.optional(),
    actions: z.array(RuntimeActionRefSchema).optional(),
    offload: z
      .object({
        targets: z.array(RuntimeOffloadTargetSchema).optional(),
      })
      .strict()
      .optional(),
    cost: RuntimeCostHintSchema.optional(),
    freshness: RuntimeFreshnessSchema.optional(),
    provenance: RuntimeProvenanceSchema.optional(),
  })
  .strict();

export const RuntimeContextConfigSchema = z
  .object({
    source: z.enum(["static", "provider", "mixed"]).optional(),
    expose: z
      .object({
        mode: z.enum(["none", "tool_hint", "prompt_summary"]).optional(),
      })
      .strict()
      .optional(),
    ttlSeconds: z.number().positive().optional(),
    validUntil: z.string().optional(),
    value: RuntimeSelfContextSchema.optional(),
  })
  .strict()
  .optional();
