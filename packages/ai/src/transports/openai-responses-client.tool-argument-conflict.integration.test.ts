// Transport-level proof for #139110: the streamed-argument preference must hold
// on a real SSE connection and a real WebSocket session, not only on a parsed
// event iterator, because both transports reach the same completion owner.
import type { Context, Tool } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "./openai-responses-loopback.test-support.js";

const lookupTool: Tool = {
  name: "lookup",
  description: "Look up a file by path.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};
const streamedArguments = '{"path":"README.md"}';
const staleArguments = '{"path":"READ"}';
const completeArguments = { path: "README.md" };
const scenarios = [
  {
    name: "stale-done-snapshot",
    itemDone: staleArguments,
    terminal: streamedArguments,
    deltas: true,
  },
  { name: "healthy", itemDone: streamedArguments, terminal: streamedArguments, deltas: true },
  {
    name: "opening-snapshot-no-deltas",
    itemDone: streamedArguments,
    terminal: streamedArguments,
    deltas: false,
    opening: "{}",
  },
] as const;

function responseEvents(scenario: (typeof scenarios)[number]) {
  const call = {
    type: "function_call",
    id: "fc_lookup",
    call_id: "call_lookup",
    name: lookupTool.name,
    status: "completed",
  };
  const events: unknown[] = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        ...call,
        arguments: "opening" in scenario && scenario.opening ? scenario.opening : "",
        status: "in_progress",
      },
    },
  ];
  if (scenario.deltas) {
    events.push(
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: call.id,
        delta: streamedArguments.slice(0, 10),
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: call.id,
        delta: streamedArguments.slice(10),
      },
    );
  }
  events.push(
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...call, arguments: scenario.itemDone },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_argument_conflict",
        status: "completed",
        output: [{ ...call, arguments: scenario.terminal }],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  );
  return () => events;
}

it.each(
  (["sse", "websocket-cached"] as const).flatMap((transport) =>
    scenarios.map((scenario) => ({ transport, scenario })),
  ),
)("real $transport stream: $scenario.name", async ({ transport, scenario }) => {
  const server = await createResponsesLoopbackServer(responseEvents(scenario));
  try {
    const context: Context = {
      messages: [{ role: "user", content: "Look up README.", timestamp: 1 }],
      tools: [lookupTool],
    };
    const stream = await createOpenAIResponsesTransportStreamFn()(responsesLoopbackModel, context, {
      apiKey: "synthetic-key-a",
      sessionId: `${transport}-${scenario.name}`,
      cacheRetention: "none",
      transport,
    });
    const events: string[] = [];
    for await (const event of stream) {
      events.push(event.type);
    }
    const result = await stream.result();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    // The request really left through the selected transport.
    expect(server.connections).toBe(transport === "sse" ? 0 : 1);
    expect(server.authorization).toEqual(["Bearer synthetic-key-a"]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.tools).toEqual([
      expect.objectContaining({ type: "function", name: lookupTool.name }),
    ]);

    // All scenarios should complete with the correct arguments from the done snapshot.
    expect(result.stopReason).toBe("toolUse");
    expect(events.filter((type) => type === "toolcall_end")).toEqual(["toolcall_end"]);
    expect(toolCalls).toEqual([
      expect.objectContaining({ name: lookupTool.name, arguments: completeArguments }),
    ]);
    // The stale snapshot must never reach the transcript.
    expect(JSON.stringify(result.content)).not.toContain('READ"');
  } finally {
    await server.close();
  }
});
