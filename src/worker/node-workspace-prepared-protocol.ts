import { z } from "zod";

const Identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value && !value.includes("\0"));
const Identity = z.object({
  gatewayNamespace: Identifier.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  environmentId: Identifier,
  preparationKey: z.string().regex(/^[a-f0-9]{64}$/u),
  cacheKey: z.string().regex(/^[a-f0-9]{64}$/u),
});
const Paths = z.object({
  workspaceDir: z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => !value.includes("\0")),
  homeDir: z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => !value.includes("\0")),
  sourceManifestRef: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
});
const Registration = Identity.extend({ action: z.literal("register"), ...Paths.shape }).strict();
const Binding = Identity.extend({
  action: z.literal("bind"),
  sessionId: Identifier,
  sessionKey: z
    .string()
    .min(1)
    .max(1_024)
    .refine((value) => value.trim() === value && !value.includes("\0")),
  ownerEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const Input = z.discriminatedUnion("action", [Registration, Binding]);
const Result = Identity.extend(Paths.shape).strict();

export type NodeWorkerPreparedWorkspaceRegistration = z.infer<typeof Registration>;
export type NodeWorkerPreparedWorkspaceBinding = z.infer<typeof Binding>;
export type NodeWorkerPreparedWorkspaceInput = z.infer<typeof Input>;
export type NodeWorkerPreparedWorkspaceResult = z.infer<typeof Result>;

export function parseNodeWorkerPreparedWorkspaceInput(
  raw?: string | null,
): NodeWorkerPreparedWorkspaceInput {
  if (!raw || Buffer.byteLength(raw, "utf8") > 16 * 1_024) {
    throw new Error("INVALID_REQUEST: invalid prepared workspace request");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_REQUEST: malformed prepared workspace request");
  }
  const parsed = Input.safeParse(value);
  if (!parsed.success) {
    throw new Error("INVALID_REQUEST: invalid prepared workspace request");
  }
  return parsed.data;
}

export function parseNodeWorkerPreparedWorkspaceResult(
  value: unknown,
): NodeWorkerPreparedWorkspaceResult | undefined {
  const parsed = Result.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
