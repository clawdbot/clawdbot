import { z } from "zod";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

const correlationId = z.string().min(1).max(1024);
const activityDetails = z
  .object({
    runId: correlationId,
    scopeId: correlationId,
    afterEntryId: correlationId.nullable(),
    startOrder: z.number().int().nonnegative(),
    parentToolCallId: correlationId.optional(),
    toolCallId: correlationId,
    toolName: z.string().min(1).max(256),
    input: z.unknown(),
    result: z.object({ content: z.array(z.unknown()), details: z.unknown().optional() }),
    isError: z.boolean(),
    startedAt: z.number().finite(),
    timestamp: z.number().finite(),
  })
  .strict();
const activitySchema = z.object({
  role: z.literal("custom"),
  customType: z.literal("openclaw.nested-tool.v1"),
  display: z.literal(true),
  excludeFromContext: z.literal(true),
  content: z.literal(""),
  details: activityDetails,
  timestamp: z.number().finite(),
});

export type NestedToolActivity = z.infer<typeof activitySchema>;

/** Validate correlation slots separately from the payloads that always require redaction. */
export function readNestedToolActivity(value: unknown): NestedToolActivity | undefined {
  const parsed = activitySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Keep each terminal activity bounded independently of provider context. */
export function createNestedToolActivity(
  details: Omit<NestedToolActivity["details"], "result"> & { result: unknown },
): NestedToolActivity {
  const input = boundedJsonUtf8Bytes(details.input, 8_192).complete
    ? structuredClone(details.input)
    : "[Nested tool input omitted: exceeds display limit]";
  const result = boundedJsonUtf8Bytes(details.result, 32_768).complete
    ? details.result
    : { content: [{ type: "text", text: "[Nested tool output omitted: exceeds display limit]" }] };
  return activitySchema.parse({
    role: "custom",
    customType: "openclaw.nested-tool.v1",
    display: true,
    excludeFromContext: true,
    content: "",
    details: { ...details, input, result },
    timestamp: details.startedAt,
  });
}

/** Tool-card content for public history. */
export function nestedToolActivityContent({ details }: NestedToolActivity) {
  const { input, result, ...call } = details;
  return [
    {
      type: "toolCall",
      id: call.toolCallId,
      runId: call.runId,
      name: call.toolName,
      arguments: input,
      parentToolCallId: call.parentToolCallId,
      timestamp: call.startedAt,
    },
    { ...call, ...result, type: "toolResult" },
  ] as const;
}

/** Hooks retain call/result evidence; model snapshots and context engines stay unchanged. */
export function projectNestedToolActivityForHooks(
  messages: readonly unknown[],
  activities: readonly NestedToolActivity[],
): unknown[] {
  return [
    ...messages,
    ...activities.map((activity) => ({
      ...activity,
      // Role/content observers need distinct invocations, not fabricated model turns.
      content: JSON.stringify({
        scopeId: activity.details.scopeId,
        toolCallId: activity.details.toolCallId,
        toolName: activity.details.toolName,
        isError: activity.details.isError,
      }),
    })),
  ];
}
