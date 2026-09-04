// QA Lab mock provider output event builders.

import type { MockAssistantMessageSpec, StreamEvent } from "./mock-openai-contracts.js";
import { MockResponseStream } from "./mock-openai-stream.js";
import { buildMockFunctionCall } from "./mock-openai-tooling.js";

export function buildRemoteCompactionV2Events(): StreamEvent[] {
  const stream = new MockResponseStream("resp_mock_compaction_1");
  stream.item({
    type: "compaction",
    encrypted_content: "QA_MOCK_REMOTE_COMPACTION_SUMMARY",
  });
  return stream.complete(16);
}

export function buildFailedResponseEvents(): StreamEvent[] {
  return new MockResponseStream(`resp_qa_failed_${Date.now()}`).fail();
}

export function buildPartialFailureEvents(partialText: string): StreamEvent[] {
  const stream = new MockResponseStream("resp_qa_partial_failed_1");
  stream.message(
    {
      id: "msg_qa_partial_failed_1",
      phase: "final_answer",
      streamDeltas: [partialText],
      text: partialText,
    },
    false,
  );
  return stream.fail();
}

export function buildReleaseAuditJson() {
  return `${JSON.stringify(
    {
      verified: false,
      findings: [
        {
          id: "REL-GATEWAY-417",
          source: "src/gateway/reconnect.ts",
          status: "retry jitter verified, resume token fallback still needs manual spot check",
          verified: true,
        },
        {
          id: "REL-CHANNEL-238",
          source: "src/channels/delivery.ts",
          status: "thread replies preserve ordering, root-channel fallback needs handoff note",
          verified: true,
        },
        {
          id: "REL-CRON-904",
          source: "src/scheduling/cron.ts",
          status: "single-run lock verified for restart wakeups",
          verified: true,
        },
        {
          id: "REL-MEMORY-552",
          source: "src/memory/recall.ts",
          status:
            "fallback summary survives empty memory search; ranking sample needs second reviewer",
          verified: true,
        },
        {
          id: "REL-PLUGIN-319",
          source: "src/plugins/runtime.ts",
          status: "bundled runtime manifest loads cleanly after restart",
          verified: true,
        },
        {
          id: "REL-INSTALL-846",
          source: "install/update.ts",
          status: "update smoke passed from previous stable tag",
          verified: true,
        },
        {
          id: "REL-DOCS-611",
          source: "docs/operator-notes.md",
          status:
            "docs mention reconnect, cron, memory, plugin, and installer checks; channel ordering and UI notes need maintainer handoff",
          verified: true,
        },
        {
          id: "REL-UI-BLOCKED",
          source: "ui/control-panel.ts",
          status: "blocked: source file was referenced by checklist but missing from the fixture",
          verified: false,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export function buildReleaseHandoffMarkdown() {
  return [
    "# Release Handoff",
    "",
    "Ready:",
    "- REL-GATEWAY-417: gateway reconnect handling checked in `src/gateway/reconnect.ts`.",
    "- REL-CRON-904: cron duplicate prevention checked in `src/scheduling/cron.ts`.",
    "- REL-PLUGIN-319: plugin runtime loading checked in `src/plugins/runtime.ts`.",
    "- REL-INSTALL-846: installer update path checked in `install/update.ts`.",
    "",
    "Follow-up:",
    "- REL-CHANNEL-238: channel delivery ordering needs maintainer handoff.",
    "- REL-MEMORY-552: memory recall fallback ranking sample needs a second reviewer.",
    "- REL-DOCS-611: docs update status needs channel ordering and UI notes.",
    "- `ui/control-panel.ts` is blocked/not found in the fixture.",
    "",
  ].join("\n");
}

export function extractPlannedToolName(events: StreamEvent[]) {
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as { type?: unknown; name?: unknown };
    if (
      (item.type === "function_call" || item.type === "custom_tool_call") &&
      typeof item.name === "string"
    ) {
      return item.name;
    }
  }
  return undefined;
}

export function extractPlannedToolIdentity(events: StreamEvent[]): {
  callId?: string;
  itemId?: string;
} {
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as { type?: unknown; id?: unknown; call_id?: unknown };
    if (
      (item.type === "function_call" || item.type === "custom_tool_call") &&
      typeof item.call_id === "string"
    ) {
      return {
        callId: item.call_id,
        itemId: typeof item.id === "string" ? item.id : undefined,
      };
    }
  }
  return {};
}

export function extractPlannedToolArgs(events: StreamEvent[]) {
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as { type?: unknown; arguments?: unknown; input?: unknown };
    if (item.type === "custom_tool_call") {
      return typeof item.input === "string" ? { input: item.input } : undefined;
    }
    if (item.type !== "function_call" || typeof item.arguments !== "string") {
      continue;
    }
    try {
      const parsed = JSON.parse(item.arguments);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function splitMockStreamingText(text: string, parts = 3) {
  if (text.length <= 1) {
    return [text];
  }
  const chunkSize = Math.max(1, Math.ceil(text.length / parts));
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkSize) {
    chunks.push(text.slice(index, index + chunkSize));
  }
  return chunks.length > 1 ? chunks : [text.slice(0, 1), text.slice(1)];
}

export function buildQaLongFinalText({
  endMarker = "TELEGRAM-LONG-FINAL-END",
  segmentPrefix = "telegram-long-final-segment",
  segmentCount = 42,
  startMarker = "TELEGRAM-LONG-FINAL-BEGIN",
}: {
  endMarker?: string;
  segmentPrefix?: string;
  segmentCount?: number;
  startMarker?: string;
} = {}) {
  const body = Array.from(
    { length: segmentCount },
    (_, index) => `${segmentPrefix}-${String(index + 1).padStart(3, "0")} ${"x".repeat(54)}`,
  ).join("\n");
  return `${startMarker}\n${body}\n${endMarker}`;
}

export function buildAssistantThenToolCallEvents(
  spec: MockAssistantMessageSpec,
  name: string,
  args: Record<string, unknown>,
): StreamEvent[] {
  const call = buildMockFunctionCall(name, args);
  const stream = new MockResponseStream(call.responseId);
  stream.message(spec);
  stream.tool(call.item);
  return stream.complete(32);
}

export function buildAssistantEvents(
  specsOrText: MockAssistantMessageSpec[] | string,
): StreamEvent[] {
  const specs =
    typeof specsOrText === "string"
      ? [
          {
            id: "msg_mock_1",
            text: specsOrText,
          },
        ]
      : specsOrText;
  const stream = new MockResponseStream("resp_mock_msg_1");
  for (const spec of specs) {
    stream.message(spec);
  }
  return stream.complete(24);
}

export function buildStreamingFinalAnswerEvents(
  id: string,
  text: string,
  previewText = text,
): StreamEvent[] {
  return buildAssistantEvents([
    {
      id,
      phase: "final_answer",
      streamDeltas: splitMockStreamingText(previewText),
      text,
    },
  ]);
}

export function buildReasoningOnlyEvents(summaryText: string, id: string): StreamEvent[] {
  const reasoningItem = {
    type: "reasoning",
    id,
    summary: [{ text: summaryText }],
  } as const;
  const stream = new MockResponseStream(`resp_${id}`);
  stream.item(reasoningItem, { ...reasoningItem, summary: [] });
  return stream.complete(8);
}

export function buildReasoningAndAssistantEvents(params: {
  reasoningId: string;
  answerText: string;
  answerId?: string;
}): StreamEvent[] {
  const reasoningItem = {
    type: "reasoning",
    id: params.reasoningId,
    summary: [],
  } as const;
  const stream = new MockResponseStream(`resp_${params.reasoningId}`);
  stream.item(reasoningItem);
  stream.message({
    id: params.answerId ?? "msg_mock_reasoned_answer",
    phase: "final_answer",
    streamDeltas: [params.answerText],
    text: params.answerText,
  });
  return stream.complete(16);
}
