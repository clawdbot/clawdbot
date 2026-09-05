import { z } from "zod";

const A2A_CONTEXT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const A2A_MESSAGE_MAX_BYTES = 64 * 1024;
const A2A_TRUNCATION_MARKER = `\n[message truncated at ${A2A_MESSAGE_MAX_BYTES} bytes]`;

type A2aPartMetadata = { metadata?: Record<string, unknown> };

type A2aMessagePart = A2aPartMetadata &
  ({ text: string } | { data: unknown } | { url: string } | { raw: string });

export type A2aMessageRecord = {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  parts: A2aMessagePart[];
  metadata?: Record<string, unknown>;
};

type A2aTaskStatus =
  | { state: "TASK_STATE_SUBMITTED" | "TASK_STATE_WORKING"; timestamp: string }
  | {
      state:
        | "TASK_STATE_COMPLETED"
        | "TASK_STATE_FAILED"
        | "TASK_STATE_CANCELED"
        | "TASK_STATE_REJECTED";
      timestamp: string;
      message?: A2aMessageRecord;
    };

type A2aTaskArtifact = {
  artifactId: string;
  name?: string;
  parts: A2aMessagePart[];
};

export type A2aTaskRecord = {
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  artifacts: A2aTaskArtifact[];
  history: A2aMessageRecord[];
};

export const A2aRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number().finite(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const A2aMetadataSchema = z.record(z.string(), z.unknown());
const A2aInboundPartSchema = z.object({
  text: z.string().optional(),
  data: z.unknown().optional(),
});

export const A2aSendMessageParamsSchema = z.object({
  message: z.object({
    messageId: z.string().min(1).optional(),
    contextId: z.string().regex(A2A_CONTEXT_PATTERN).optional(),
    taskId: z.string().min(1).optional(),
    role: z.enum(["ROLE_USER", "ROLE_AGENT", "user", "agent"]),
    parts: z.array(z.unknown()),
    metadata: A2aMetadataSchema.optional(),
  }),
  configuration: z
    .object({
      acceptedOutputModes: z.array(z.string()).optional(),
      historyLength: z.number().int().nonnegative().optional(),
      returnImmediately: z.boolean().optional(),
    })
    .optional(),
  tenant: z.string().optional(),
  metadata: A2aMetadataSchema.optional(),
});

export const A2aTaskRequestParamsSchema = z.object({
  id: z.string().min(1),
  historyLength: z.number().int().nonnegative().optional(),
  tenant: z.string().optional(),
});

type A2aCanonicalMethod = "SendMessage" | "GetTask";

// Hermes-generation A2A 0.3 peers use dotted RPC names; only these three
// explicitly supported interoperability aliases are accepted.
const A2A_METHOD_ALIASES: Readonly<Record<string, A2aCanonicalMethod>> = {
  SendMessage: "SendMessage",
  GetTask: "GetTask",
  "message/send": "SendMessage",
  "tasks/get": "GetTask",
};

const A2A_UNSUPPORTED_METHODS = new Set([
  // Cancellation is refused rather than faked: a dispatched agent run has no
  // plugin-facing abort seam, so acknowledging it would report a terminal state
  // while the run kept using tools.
  "CancelTask",
  "tasks/cancel",
  "ListTasks",
  "SendStreamingMessage",
  "SubscribeToTask",
  "CreateTaskPushNotificationConfig",
  "SetTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
  "GetExtendedAgentCard",
]);

export function resolveA2aRpcMethod(
  method: string,
): A2aCanonicalMethod | "unsupported" | undefined {
  if (Object.hasOwn(A2A_METHOD_ALIASES, method)) {
    return A2A_METHOD_ALIASES[method];
  }
  return A2A_UNSUPPORTED_METHODS.has(method) ? "unsupported" : undefined;
}

export function isA2aContextId(value: string): boolean {
  return A2A_CONTEXT_PATTERN.test(value);
}

export function extractA2aMessageText(parts: unknown[]): string | undefined {
  const textParts: string[] = [];
  for (const candidate of parts) {
    const parsed = A2aInboundPartSchema.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }
    if (typeof parsed.data.text === "string") {
      textParts.push(parsed.data.text);
    } else if (Object.hasOwn(parsed.data, "data") && parsed.data.data !== undefined) {
      textParts.push(JSON.stringify(parsed.data.data));
    }
  }

  const text = textParts.join("\n");
  if (!text.trim()) {
    return undefined;
  }
  if (Buffer.byteLength(text) <= A2A_MESSAGE_MAX_BYTES) {
    return text;
  }

  const encoded = Buffer.from(text);
  let prefixBytes = A2A_MESSAGE_MAX_BYTES - Buffer.byteLength(A2A_TRUNCATION_MARKER);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (prefixBytes > 0) {
    try {
      return decoder.decode(encoded.subarray(0, prefixBytes)) + A2A_TRUNCATION_MARKER;
    } catch {
      // Never split a multibyte UTF-8 character at the transport byte cap.
      prefixBytes -= 1;
    }
  }
  return A2A_TRUNCATION_MARKER.trimStart();
}

export class A2aProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "A2aProtocolError";
  }
}
