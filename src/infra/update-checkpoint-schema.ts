import path from "node:path";
import { z } from "zod";
import { UpdateCheckpointPluginIndexMutationSchema } from "./update-checkpoint-plugin-index.js";
export const absolutePath = z
  .string()
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const CheckpointFileStateSchema = z
  .object({
    kind: z.enum(["file", "directory"]),
    sha256: digest,
    descendantIdentitySha256: digest.optional(),
    mode: z.number().int(),
    identity: z
      .object({
        dev: z.number(),
        ino: z.number(),
        size: z.number(),
        mtimeMs: z.number(),
        ctimeMs: z.number(),
      })
      .strict(),
  })
  .strict();
export const bindingSchema = z
  .object({
    runId: z.string().min(1),
    stateDir: absolutePath,
    configPath: absolutePath,
    fromRuntime: z
      .object({ root: absolutePath, version: z.string().min(1), nodePath: absolutePath })
      .strict(),
  })
  .strict();
export const resourceSchema = z
  .object({
    sourcePath: absolutePath,
    kind: z.enum(["config", "state", "sqlite", "plugin", "service"]),
    restore: z.enum(["replace", "preserve"]),
  })
  .strict();
/** A locator, never serialized authority. Reopen against a fresh binding and artifact root. */
export const UpdateCheckpointRefSchema = z
  .object({
    checkpointId: z.string().uuid(),
    manifestPath: absolutePath,
    manifestSha256: digest,
  })
  .strict();
export type UpdateCheckpointRef = z.infer<typeof UpdateCheckpointRefSchema>;
export const manifestSchema = z
  .object({
    checkpointId: z.string().uuid(),
    purpose: z.enum(["checkpoint", "preimage"]).optional(),
    preimageRef: UpdateCheckpointRefSchema.optional(),
    binding: bindingSchema,
    createdAtMs: z.number().int(),
    exclusions: z.array(z.string()),
    pluginIndexMutations: z.array(UpdateCheckpointPluginIndexMutationSchema).max(1024).optional(),
    resources: z.array(
      resourceSchema
        .extend({
          artifact: z
            .string()
            .regex(/^resource-[0-9]+$/u)
            .nullable(),
          captured: CheckpointFileStateSchema.nullable(),
          // Older artifacts remain inspectable, but cannot authorize file replacement.
          sourceState: CheckpointFileStateSchema.nullable().optional(),
          // Records validation of owner-supplied facts, never live mutation authority.
          sourceBindingValidated: z.boolean().optional(),
          userVersion: z.number().int().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type UpdateCheckpointBinding = z.infer<typeof bindingSchema>;
export type UpdateCheckpointResource = z.infer<typeof resourceSchema>;
export type UpdateCheckpointManifest = z.infer<typeof manifestSchema>;
export type ReopenedUpdateCheckpoint = {
  ref: UpdateCheckpointRef;
  manifest: UpdateCheckpointManifest;
};
export type UpdateCheckpointReadAccess = {
  artifactRoot: string;
  binding: UpdateCheckpointBinding;
};
export type UpdateCheckpointAccess = UpdateCheckpointReadAccess & {
  /** Current owner-held exclusion/claim. Throws if any state writer can still run. */
  assertQuiescent: () => void;
};
