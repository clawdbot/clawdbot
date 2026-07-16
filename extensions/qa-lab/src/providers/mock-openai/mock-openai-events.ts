// QA Lab mock provider output event builders.

import type { StreamEvent } from "./mock-openai-contracts.js";
import {
  readTargetFromPrompt,
  buildMockFunctionCall,
  buildToolCallEventsWithArgs,
} from "./mock-openai-tooling.js";
export function buildToolCallEvents(prompt: string): StreamEvent[] {
  const targetPath = readTargetFromPrompt(prompt);
  return buildToolCallEventsWithArgs("read", { path: targetPath });
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
    if (item.type === "function_call" && typeof item.name === "string") {
      return item.name;
    }
  }
  return undefined;
}

export function extractPlannedToolCallId(events: StreamEvent[]) {
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as { type?: unknown; call_id?: unknown };
    if (item.type === "function_call" && typeof item.call_id === "string") {
      return item.call_id;
    }
  }
  return undefined;
}

export function extractPlannedToolArgs(events: StreamEvent[]) {
  for (const event of events) {
    if (event.type !== "response.output_item.done") {
      continue;
    }
    const item = event.item as { type?: unknown; arguments?: unknown };
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

type MockAssistantMessageSpec = {
  id: string;
  phase?: "commentary" | "final_answer";
  streamDeltas?: string[];
  text: string;
};

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

function buildAssistantOutputItem(spec: MockAssistantMessageSpec) {
  return {
    type: "message",
    id: spec.id,
    role: "assistant",
    status: "completed",
    ...(spec.phase ? { phase: spec.phase } : {}),
    content: [{ type: "output_text", text: spec.text, annotations: [] }],
  } as const;
}

function appendAssistantMessageEvents(events: StreamEvent[], spec: MockAssistantMessageSpec) {
  events.push({
    type: "response.output_item.added",
    item: {
      type: "message",
      id: spec.id,
      role: "assistant",
      ...(spec.phase ? { phase: spec.phase } : {}),
      content: [],
      status: "in_progress",
    },
  });
  for (const delta of spec.streamDeltas ?? []) {
    events.push({
      type: "response.output_text.delta",
      item_id: spec.id,
      output_index: 0,
      content_index: 0,
      delta,
    });
  }
  if ((spec.streamDeltas ?? []).length > 0) {
    events.push({
      type: "response.output_text.done",
      item_id: spec.id,
      output_index: 0,
      content_index: 0,
      text: spec.text,
    });
  }
  events.push({
    type: "response.output_item.done",
    item: buildAssistantOutputItem(spec),
  });
}

export function buildAssistantThenToolCallEvents(
  spec: MockAssistantMessageSpec,
  name: string,
  args: Record<string, unknown>,
): StreamEvent[] {
  const call = buildMockFunctionCall(name, args);
  const message = buildAssistantOutputItem(spec);
  const events: StreamEvent[] = [];
  appendAssistantMessageEvents(events, spec);
  events.push({
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: call.itemId,
      call_id: call.callId,
      name,
      arguments: "",
    },
  });
  events.push({ type: "response.function_call_arguments.delta", delta: call.serialized });
  events.push({
    type: "response.output_item.done",
    item: call.item,
  });
  events.push({
    type: "response.completed",
    response: {
      id: call.responseId,
      status: "completed",
      output: [message, call.item],
      usage: { input_tokens: 64, output_tokens: 32, total_tokens: 96 },
    },
  });
  return events;
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
  const renderedSpecs = specs.map((spec) => ({ spec, item: buildAssistantOutputItem(spec) }));
  const output = renderedSpecs.map(({ item }) => item);
  const events: StreamEvent[] = [];

  for (const [outputIndex, { spec, item }] of renderedSpecs.entries()) {
    events.push({
      type: "response.output_item.added",
      item: {
        type: "message",
        id: spec.id,
        role: "assistant",
        ...(spec.phase ? { phase: spec.phase } : {}),
        content: [],
        status: "in_progress",
      },
    });
    for (const delta of spec.streamDeltas ?? []) {
      events.push({
        type: "response.output_text.delta",
        item_id: spec.id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      });
    }
    if ((spec.streamDeltas ?? []).length > 0) {
      events.push({
        type: "response.output_text.done",
        item_id: spec.id,
        output_index: outputIndex,
        content_index: 0,
        text: spec.text,
      });
    }
    events.push({
      type: "response.output_item.done",
      item,
    });
  }

  events.push({
    type: "response.completed",
    response: {
      id: "resp_mock_msg_1",
      status: "completed",
      output,
      usage: { input_tokens: 64, output_tokens: 24, total_tokens: 88 },
    },
  });
  return events;
}

export function buildReasoningOnlyEvents(summaryText: string, id: string): StreamEvent[] {
  const reasoningItem = {
    type: "reasoning",
    id,
    summary: [{ text: summaryText }],
  } as const;
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "reasoning",
        id,
        summary: [],
      },
    },
    {
      type: "response.output_item.done",
      item: reasoningItem,
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [reasoningItem],
        usage: { input_tokens: 64, output_tokens: 8, total_tokens: 72 },
      },
    },
  ];
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
  const answerItem = buildAssistantOutputItem({
    id: params.answerId ?? "msg_mock_reasoned_answer",
    phase: "final_answer",
    text: params.answerText,
  });
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "reasoning",
        id: params.reasoningId,
        summary: [],
      },
    },
    {
      type: "response.output_item.done",
      item: reasoningItem,
    },
    {
      type: "response.output_item.added",
      item: {
        type: "message",
        id: answerItem.id,
        role: "assistant",
        phase: "final_answer",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_text.delta",
      item_id: answerItem.id,
      output_index: 1,
      content_index: 0,
      delta: params.answerText,
    },
    {
      type: "response.output_text.done",
      item_id: answerItem.id,
      output_index: 1,
      content_index: 0,
      text: params.answerText,
    },
    {
      type: "response.output_item.done",
      item: answerItem,
    },
    {
      type: "response.completed",
      response: {
        id: `resp_${params.reasoningId}`,
        status: "completed",
        output: [reasoningItem, answerItem],
        usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
      },
    },
  ];
}
