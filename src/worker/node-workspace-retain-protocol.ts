import { z } from "zod";

const REQUEST_MAX_BYTES = 1024 * 1024;
const RETAIN_MAX_ENTRIES = 4_096;
const MANIFEST_REFS_MAX_ENTRIES = 32;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;

const BoundedIdentifierSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !value.includes("\0"));

const ManifestRefsSchema = z
  .array(z.string().regex(MANIFEST_REF_PATTERN))
  .max(MANIFEST_REFS_MAX_ENTRIES)
  .superRefine((refs, context) => {
    if (new Set(refs).size !== refs.length) {
      context.addIssue({ code: "custom", message: "manifestRefs must not contain duplicates" });
    }
  })
  .transform((refs) => refs.toSorted())
  .nullable();

const RetainEntrySchema = z
  .object({
    environmentId: BoundedIdentifierSchema,
    sessionId: BoundedIdentifierSchema,
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    manifestRefs: ManifestRefsSchema,
  })
  .strict();

const RetainInputSchema = z
  .object({
    version: z.literal(1),
    gatewayNamespace: BoundedIdentifierSchema.regex(GATEWAY_NAMESPACE_PATTERN),
    controllerId: BoundedIdentifierSchema.max(128),
    sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    retain: z.array(RetainEntrySchema).max(RETAIN_MAX_ENTRIES),
  })
  .strict();

const RetainResultSchema = z
  .object({
    applied: z.boolean(),
    deleted: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    hasMore: z.boolean(),
  })
  .strict();

export type NodeWorkerWorkspaceRetainEntry = z.infer<typeof RetainEntrySchema>;
export type NodeWorkerWorkspaceRetainInput = z.infer<typeof RetainInputSchema>;
export type NodeWorkerWorkspaceRetainResult = z.infer<typeof RetainResultSchema>;

export function parseNodeWorkerWorkspaceRetainInput(
  raw?: string | null,
): NodeWorkerWorkspaceRetainInput {
  if (!raw || Buffer.byteLength(raw, "utf8") > REQUEST_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: invalid node worker workspace retain request");
  }
  try {
    const parsed = RetainInputSchema.parse(JSON.parse(raw) as unknown);
    const keys = new Set<string>();
    for (const entry of parsed.retain) {
      const key = `${entry.environmentId}\0${entry.sessionId}\0${entry.generation}`;
      if (keys.has(key)) {
        throw new Error("workspace retain entries must be unique");
      }
      keys.add(key);
    }
    parsed.retain.sort(
      (left, right) =>
        left.environmentId.localeCompare(right.environmentId) ||
        left.sessionId.localeCompare(right.sessionId) ||
        left.generation - right.generation,
    );
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`INVALID_REQUEST: invalid node worker workspace retain request: ${detail}`, {
      cause: error,
    });
  }
}

export function parseNodeWorkerWorkspaceRetainResult(
  value: unknown,
): NodeWorkerWorkspaceRetainResult | null {
  return RetainResultSchema.safeParse(value).data ?? null;
}
