import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderReplayState,
} from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  suppressOpenAIResponsesCompaction,
} from "./openai-responses-compaction-replay.js";
import { stringifyRedactedEvent, stringifyRedactedPayload } from "./openai-responses-debug.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";
import {
  processResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";
import { stripCompactionReplayCheckpoint } from "./provider-compaction-replay.js";

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;
const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function compactionState(
  sourceModel: Model = model,
  overrides: Partial<ProviderReplayState> = {},
): ProviderReplayState {
  const metadata = buildOpenAIResponsesReasoningReplayMetadata(sourceModel, replayIdentity);
  if (!metadata.baseUrlHash) {
    throw new Error("test model must have a replayable base URL");
  }
  return {
    v: 1,
    type: "openai-responses-compaction",
    id: "cmp_replay",
    data: "opaque-replay-compaction",
    replayIndex: 1,
    provider: metadata.provider,
    api: metadata.api,
    model: metadata.model,
    baseUrlHash: metadata.baseUrlHash,
    sessionHash: metadata.sessionHash,
    authProfileHash: metadata.authProfileHash,
    ...overrides,
  };
}

async function* events(
  values: Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const value of values) {
    yield value as OpenAIResponsesStreamEvent;
  }
}

async function processEvents(values: Record<string, unknown>[]): Promise<AssistantMessage> {
  const output = createOutput();
  await processResponsesStream(events(values), output, { push: () => undefined }, model, {
    reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity),
  });
  return output;
}

function replayTypes(output: AssistantMessage): string[] {
  return convertResponsesMessages(
    model,
    { messages: [output] },
    new Set(["openai"]),
    replayIdentity,
  ).flatMap((item) => (typeof item.type === "string" ? [item.type] : []));
}

const responseConverters = [
  {
    name: "transport-owned",
    convert: (
      context: Context,
      identity: { sessionId?: string; authProfileId?: string } = replayIdentity,
    ) => convertResponsesMessages(model, context, new Set(["openai"]), identity),
  },
  {
    name: "provider-owned",
    convert: (
      context: Context,
      identity: { sessionId?: string; authProfileId?: string } = replayIdentity,
    ) => convertProviderResponsesMessages(model, context, new Set(["openai"]), identity),
  },
] as const;

function createAssistant(
  content: AssistantMessage["content"],
  providerReplay?: ProviderReplayState,
): AssistantMessage {
  return { ...createOutput(), content, ...(providerReplay ? { providerReplay } : {}) };
}

function responseMessage(id: string, text: string) {
  return {
    type: "message" as const,
    id,
    role: "assistant" as const,
    status: "completed" as const,
    content: [{ type: "output_text" as const, text, annotations: [] }],
  };
}

describe("OpenAI Responses compaction replay", () => {
  it("strips only exact compaction checkpoints with structural sharing", () => {
    const unchanged = createOutput();
    expect(stripCompactionReplayCheckpoint(unchanged)).toBe(unchanged);

    const checkpoint = createAssistant(
      [{ type: "text", text: "checkpoint owner" }],
      compactionState(),
    );
    const stripped = stripCompactionReplayCheckpoint(checkpoint);
    expect(stripped).not.toBe(checkpoint);
    expect(stripped.content).toBe(checkpoint.content);
    expect(stripped).not.toHaveProperty("providerReplay");
    expect(checkpoint.providerReplay).toEqual(compactionState());

    const suppression = createOutput();
    suppressOpenAIResponsesCompaction(suppression, model, replayIdentity);
    expect(stripCompactionReplayCheckpoint(suppression)).toBe(suppression);

    const unrelated = createAssistant([], compactionState(model, { type: "future-replay" }));
    expect(stripCompactionReplayCheckpoint(unrelated)).toBe(unrelated);
  });

  it("persists a streamed compaction output item as opaque provider replay state", async () => {
    const output = createOutput();

    await processResponsesStream(
      events([
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "compaction",
            id: "cmp_streamed",
            encrypted_content: "opaque-streamed-compaction",
          },
        },
        {
          type: "response.completed",
          response: { id: "resp_compacted", status: "completed", output: [] },
        },
      ]),
      output,
      { push: () => undefined },
      model,
      {
        reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity),
      },
    );

    expect((output as AssistantMessage & { providerReplay?: unknown }).providerReplay).toEqual({
      v: 1,
      type: "openai-responses-compaction",
      id: "cmp_streamed",
      data: "opaque-streamed-compaction",
      replayIndex: 0,
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.6-luna",
      baseUrlHash: expect.any(String),
      sessionHash: expect.any(String),
      authProfileHash: expect.any(String),
    });
    expect(output.content).toEqual([]);
    expect(JSON.stringify(output.content)).not.toContain("opaque-streamed-compaction");
  });

  it("recovers a compaction item from terminal response output", async () => {
    const output = createOutput();

    await processResponsesStream(
      events([
        {
          type: "response.completed",
          response: {
            id: "resp_terminal_compacted",
            status: "completed",
            output: [
              {
                type: "compaction",
                id: "cmp_terminal",
                encrypted_content: "opaque-terminal-compaction",
              },
            ],
          },
        },
      ]),
      output,
      { push: () => undefined },
      model,
      {
        reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity),
      },
    );

    expect(output.providerReplay).toMatchObject({
      type: "openai-responses-compaction",
      id: "cmp_terminal",
      data: "opaque-terminal-compaction",
      replayIndex: 0,
      sessionHash: expect.any(String),
      authProfileHash: expect.any(String),
    });
  });

  it("recovers and replays a terminal-only compaction without an id", async () => {
    const output = await processEvents([
      {
        type: "response.completed",
        response: {
          id: "resp_terminal_idless",
          status: "completed",
          output: [
            {
              type: "compaction",
              encrypted_content: "opaque-terminal-idless",
            },
          ],
        },
      },
    ]);

    expect(output.providerReplay).toMatchObject({
      type: "openai-responses-compaction",
      data: "opaque-terminal-idless",
      replayIndex: 0,
    });
    expect(output.providerReplay).not.toHaveProperty("id");
    expect(
      convertResponsesMessages(
        model,
        { messages: [output] },
        new Set(["openai"]),
        replayIdentity,
      ).find((item) => item.type === "compaction"),
    ).toEqual({
      type: "compaction",
      encrypted_content: "opaque-terminal-idless",
    });
  });

  it("keeps an identical captured idless compaction without replacing its state", async () => {
    const output = createOutput();
    const existingReplay = compactionState(model, {
      id: undefined,
      data: "opaque-terminal-idless",
      replayIndex: 7,
    });
    delete existingReplay.id;
    output.providerReplay = existingReplay;

    await processResponsesStream(
      events([
        {
          type: "response.completed",
          response: {
            id: "resp_terminal_idless_duplicate",
            status: "completed",
            output: [
              {
                type: "compaction",
                encrypted_content: "opaque-terminal-idless",
              },
            ],
          },
        },
      ]),
      output,
      { push: () => undefined },
      model,
      {
        reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity),
      },
    );

    expect(output.providerReplay).toBe(existingReplay);
    expect(output.providerReplay.replayIndex).toBe(7);
  });

  it("replaces an idless compaction when its encrypted payload changes", async () => {
    const output = createOutput();
    const existingReplay = compactionState(model, {
      id: undefined,
      data: "opaque-terminal-idless-old",
      replayIndex: 0,
    });
    delete existingReplay.id;
    output.providerReplay = existingReplay;

    await processResponsesStream(
      events([
        {
          type: "response.completed",
          response: {
            id: "resp_terminal_idless_changed",
            status: "completed",
            output: [
              {
                type: "compaction",
                encrypted_content: "opaque-terminal-idless-new",
              },
            ],
          },
        },
      ]),
      output,
      { push: () => undefined },
      model,
      {
        reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity),
      },
    );

    expect(output.providerReplay).not.toBe(existingReplay);
    expect(output.providerReplay).toMatchObject({
      type: "openai-responses-compaction",
      data: "opaque-terminal-idless-new",
      replayIndex: 0,
    });
  });

  it("orders reasoning, compaction, and message by normalized replay content", async () => {
    const output = await processEvents([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_before", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_before",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
          encrypted_content: "opaque-reasoning",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "compaction", id: "cmp_middle", encrypted_content: "opaque-middle" },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "compaction", id: "cmp_middle", encrypted_content: "opaque-middle" },
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: {
          type: "message",
          id: "msg_after",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
      },
      {
        type: "response.completed",
        response: { id: "resp_ordered", status: "completed", output: [] },
      },
    ]);

    expect(output.providerReplay?.replayIndex).toBe(1);
    expect(replayTypes(output)).toEqual(["compaction", "message"]);
  });

  it("orders a function call before compaction", async () => {
    const output = await processEvents([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_before",
          call_id: "call_before",
          name: "lookup",
          arguments: "",
          status: "in_progress",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_before",
          call_id: "call_before",
          name: "lookup",
          arguments: "{}",
          status: "completed",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "compaction", id: "cmp_after_call", encrypted_content: "opaque-call" },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "compaction", id: "cmp_after_call", encrypted_content: "opaque-call" },
      },
      {
        type: "response.completed",
        response: { id: "resp_call", status: "completed", output: [] },
      },
    ]);

    expect(output.providerReplay?.replayIndex).toBe(1);
    expect(replayTypes(output)).toEqual(["compaction"]);
  });

  it("does not count unsupported provider output before compaction", async () => {
    const searchItem = { type: "web_search_call", id: "ws_ignored", status: "completed" };
    const output = await processEvents([
      { type: "response.output_item.done", output_index: 0, item: searchItem },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "reasoning", id: "rs_kept", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "reasoning",
          id: "rs_kept",
          summary: [{ type: "summary_text", text: "thought" }],
          content: [],
          encrypted_content: "opaque-kept-reasoning",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { type: "compaction", id: "cmp_after_search", encrypted_content: "opaque-search" },
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: { type: "compaction", id: "cmp_after_search", encrypted_content: "opaque-search" },
      },
      {
        type: "response.output_item.done",
        output_index: 3,
        item: {
          type: "message",
          id: "msg_after_search",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
      },
      {
        type: "response.completed",
        response: { id: "resp_search", status: "completed", output: [] },
      },
    ]);

    expect(output.providerReplay?.replayIndex).toBe(1);
    expect(replayTypes(output)).toEqual(["compaction", "message"]);
  });

  it("derives a terminal-only replay index from normalized output", async () => {
    const output = await processEvents([
      {
        type: "response.completed",
        response: {
          id: "resp_terminal_order",
          status: "completed",
          output: [
            { type: "web_search_call", id: "ws_terminal", status: "completed" },
            {
              type: "compaction",
              id: "cmp_terminal_order",
              encrypted_content: "opaque-terminal-order",
            },
            {
              type: "message",
              id: "msg_terminal_after",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "answer", annotations: [] }],
            },
          ],
        },
      },
    ]);

    expect(output.providerReplay?.replayIndex).toBe(0);
    expect(replayTypes(output)).toEqual(["compaction", "message"]);
  });

  it("places terminal compaction before an already streamed message", async () => {
    const message = responseMessage("msg_streamed_after", "answer after compaction");
    const output = await processEvents([
      { type: "response.output_item.done", output_index: 1, item: message },
      {
        type: "response.completed",
        response: {
          id: "resp_terminal_before_streamed",
          status: "completed",
          output: [
            {
              type: "compaction",
              id: "cmp_before_streamed",
              encrypted_content: "opaque-before-streamed",
            },
            message,
          ],
        },
      },
    ]);

    expect(output.providerReplay?.replayIndex).toBe(0);
    expect(replayTypes(output)).toEqual(["compaction", "message"]);
  });

  it("places terminal compaction between two completed normalized outputs", async () => {
    const first = responseMessage("msg_before_terminal", "first answer");
    const second = responseMessage("msg_after_terminal", "second answer");
    const output = await processEvents([
      { type: "response.output_item.done", output_index: 0, item: first },
      { type: "response.output_item.done", output_index: 2, item: second },
      {
        type: "response.completed",
        response: {
          id: "resp_terminal_between",
          status: "completed",
          output: [
            first,
            {
              type: "compaction",
              id: "cmp_between_completed",
              encrypted_content: "opaque-between-completed",
            },
            second,
          ],
        },
      },
    ]);

    expect(output.content).toHaveLength(2);
    expect(output.providerReplay?.replayIndex).toBe(1);
    expect(replayTypes(output)).toEqual(["compaction", "message"]);
    expect(
      JSON.stringify(
        convertResponsesMessages(
          model,
          { messages: [output] },
          new Set(["openai"]),
          replayIdentity,
        ),
      ),
    ).not.toContain("first answer");
  });

  it("places terminal compaction after completed output at the append boundary", async () => {
    const message = responseMessage("msg_before_tail", "answer before compaction");
    const output = await processEvents([
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: {
          id: "resp_terminal_after",
          status: "completed",
          output: [
            message,
            {
              type: "compaction",
              id: "cmp_after_completed",
              encrypted_content: "opaque-after-completed",
            },
          ],
        },
      },
    ]);

    expect(output.providerReplay?.replayIndex).toBe(1);
    expect(replayTypes(output)).toEqual(["compaction"]);
  });

  it("uses the collapsed message index as the terminal compaction boundary", async () => {
    const first = responseMessage("msg_snapshot_first", "answer");
    const cumulative = responseMessage("msg_snapshot_second", "answer extended");
    const output = await processEvents([
      { type: "response.output_item.done", output_index: 0, item: first },
      { type: "response.output_item.done", output_index: 2, item: cumulative },
      {
        type: "response.completed",
        response: {
          id: "resp_terminal_collapsed",
          status: "completed",
          output: [
            first,
            {
              type: "compaction",
              id: "cmp_before_collapsed_snapshot",
              encrypted_content: "opaque-before-collapsed",
            },
            cumulative,
          ],
        },
      },
    ]);

    expect(output.content).toEqual([
      expect.objectContaining({ type: "text", text: "answer extended" }),
    ]);
    expect(output.providerReplay?.replayIndex).toBe(0);
    expect(replayTypes(output)).toEqual(["compaction", "message"]);
  });

  it("replays the newest compatible item and prunes its complete prefix", () => {
    const older = createOutput();
    older.providerReplay = compactionState(model, {
      id: "cmp_older",
      data: "opaque-older-compaction",
      replayIndex: 0,
    });
    const newest = createOutput();
    newest.content = [
      { type: "text", text: "before" },
      { type: "text", text: "after" },
    ];
    newest.providerReplay = compactionState(model, {
      id: "cmp_newest",
      data: "opaque-newest-compaction",
      replayIndex: 1,
    });

    const input = convertResponsesMessages(
      model,
      {
        messages: [
          { role: "user", content: "first", timestamp: 1 },
          older,
          { role: "user", content: "second", timestamp: 2 },
          newest,
          { role: "user", content: "next", timestamp: 3 },
        ],
      },
      new Set(["openai"]),
      replayIdentity,
    );

    expect(input.filter((item) => item.type === "compaction")).toEqual([
      {
        type: "compaction",
        id: "cmp_newest",
        encrypted_content: "opaque-newest-compaction",
      },
    ]);
    expect(input.map((item) => item.type)).toEqual(["compaction", "message", "message"]);
  });

  it.each(responseConverters)(
    "$name keeps instructions, owner output after compaction, and later messages",
    ({ convert }) => {
      const prefixCall = createAssistant([
        {
          type: "toolCall",
          id: "call_prefix|fc_prefix",
          name: "lookup",
          arguments: { prefix: true },
        },
      ]);
      const owner = createAssistant(
        [
          { type: "text", text: "owner text before compaction" },
          {
            type: "thinking",
            thinking: "reasoning after compaction",
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              id: "rs_after_compaction",
              summary: [],
            }),
          },
          { type: "text", text: "owner text after compaction" },
          {
            type: "toolCall",
            id: "call_after|fc_after",
            name: "lookup",
            arguments: { after: true },
          },
        ],
        compactionState(model, { replayIndex: 1 }),
      );
      const laterAssistant = createAssistant([{ type: "text", text: "later assistant" }]);

      const input = convert({
        systemPrompt: "current system instructions",
        messages: [
          { role: "user", content: "prefix user", timestamp: 1 },
          createAssistant([{ type: "text", text: "prefix assistant" }]),
          prefixCall,
          {
            role: "toolResult",
            toolCallId: "call_prefix|fc_prefix",
            toolName: "lookup",
            content: [{ type: "text", text: "prefix tool result" }],
            isError: false,
            timestamp: 2,
          },
          owner,
          {
            role: "toolResult",
            toolCallId: "call_after|fc_after",
            toolName: "lookup",
            content: [{ type: "text", text: "after tool result" }],
            isError: false,
            timestamp: 3,
          },
          { role: "user", content: "later user", timestamp: 4 },
          laterAssistant,
          { role: "user", content: "active current user prompt", timestamp: 5 },
        ],
      });

      expect(input.map((item) => item.type)).toEqual([
        "message",
        "compaction",
        "reasoning",
        "message",
        "function_call",
        "function_call_output",
        "message",
        "message",
        "message",
      ]);
      expect(input[0]).toMatchObject({ type: "message", role: "developer" });
      expect(input[1]).toMatchObject({ type: "compaction", id: "cmp_replay" });
      const encoded = JSON.stringify(input);
      expect(encoded).toContain("current system instructions");
      expect(encoded).toContain("owner text after compaction");
      expect(encoded).toContain("after tool result");
      expect(encoded).toContain("later user");
      expect(encoded).toContain("later assistant");
      expect(encoded).toContain("active current user prompt");
      expect(encoded).not.toContain("prefix user");
      expect(encoded).not.toContain("prefix assistant");
      expect(encoded).not.toContain("prefix tool result");
      expect(encoded).not.toContain("owner text before compaction");
    },
  );

  it.each(responseConverters)(
    "$name keeps a real post-compaction output whose call was compacted",
    ({ convert }) => {
      const owner = createAssistant(
        [
          {
            type: "toolCall",
            id: "call_before|fc_before",
            name: "lookup",
            arguments: { before: true },
          },
        ],
        compactionState(model, { replayIndex: 1 }),
      );
      const input = convert({
        messages: [
          owner,
          {
            role: "toolResult",
            toolCallId: "call_before|fc_before",
            toolName: "lookup",
            content: [{ type: "text", text: "before output" }],
            isError: false,
            timestamp: 1,
          },
        ],
      });

      expect(input.map((item) => item.type)).toEqual(["compaction", "function_call_output"]);
      expect(input.some((item) => item.type === "function_call")).toBe(false);
      expect(input.filter((item) => item.type === "function_call_output")).toMatchObject([
        { call_id: "call_before", output: "before output" },
      ]);
      expect(JSON.stringify(input)).not.toContain("No result provided");
      expect(JSON.stringify(input)).not.toContain("aborted");
      expect(owner.content).toEqual([
        expect.objectContaining({ type: "toolCall", id: "call_before|fc_before" }),
      ]);
    },
  );

  it.each(responseConverters)(
    "$name keeps the existing synthetic repair only for a retained call",
    ({ convert }) => {
      const owner = createAssistant(
        [
          {
            type: "toolCall",
            id: "call_before|fc_before",
            name: "lookup",
            arguments: { before: true },
          },
          {
            type: "toolCall",
            id: "call_after|fc_after",
            name: "lookup",
            arguments: { after: true },
          },
        ],
        compactionState(model, { replayIndex: 1 }),
      );
      const input = convert({ messages: [owner] });

      expect(input.map((item) => item.type)).toEqual([
        "compaction",
        "function_call",
        "function_call_output",
      ]);
      expect(input.filter((item) => item.type === "function_call_output")).toMatchObject([
        { call_id: "call_after", output: "No result provided" },
      ]);
      expect(input.filter((item) => item.type === "function_call_output")).toHaveLength(1);
      expect(JSON.stringify(input)).not.toContain("call_before");
    },
  );

  it.each(responseConverters)(
    "$name leaves the full transcript unchanged when compaction is incompatible",
    ({ convert }) => {
      const older = createAssistant(
        [{ type: "text", text: "older assistant" }],
        compactionState(model, { replayIndex: 0 }),
      );
      const incompatible = createAssistant(
        [{ type: "text", text: "newer incompatible assistant" }],
        compactionState(model, { model: "other-model", replayIndex: 0 }),
      );
      const input = convert({
        messages: [
          { role: "user", content: "first user", timestamp: 1 },
          older,
          { role: "user", content: "second user", timestamp: 2 },
          incompatible,
          { role: "user", content: "active user", timestamp: 3 },
        ],
      });

      expect(input.some((item) => item.type === "compaction")).toBe(false);
      const encoded = JSON.stringify(input);
      expect(encoded).toContain("first user");
      expect(encoded).toContain("older assistant");
      expect(encoded).toContain("second user");
      expect(encoded).toContain("newer incompatible assistant");
      expect(encoded).toContain("active user");
    },
  );

  it.each(responseConverters)(
    "$name preserves existing no-prune conversion when no compaction exists",
    ({ convert }) => {
      const input = convert({
        systemPrompt: "system stays",
        messages: [
          { role: "user", content: "first user", timestamp: 1 },
          createAssistant([{ type: "text", text: "assistant stays" }]),
          { role: "user", content: "active user", timestamp: 2 },
        ],
      });

      expect(input.map((item) => item.type)).toEqual(["message", "message", "message", "message"]);
      expect(JSON.stringify(input)).toContain("first user");
      expect(JSON.stringify(input)).toContain("assistant stays");
      expect(JSON.stringify(input)).toContain("active user");
    },
  );

  it("replays the item through the provider-owned Responses runtime", () => {
    const assistant = createOutput();
    assistant.content = [{ type: "text", text: "after compaction" }];
    assistant.providerReplay = compactionState(model, { replayIndex: 0 });

    const input = convertProviderResponsesMessages(
      model,
      { messages: [assistant] },
      new Set(["openai"]),
      replayIdentity,
    );

    expect(input.map((item) => item.type)).toEqual(["compaction", "message"]);
  });

  it.each(responseConverters)(
    "$name replays an empty checkpoint owner when request identities match",
    ({ convert }) => {
      const assistant = createOutput();
      assistant.providerReplay = compactionState(model, { replayIndex: 0 });

      expect(convert({ messages: [assistant] }).map((item) => item.type)).toEqual(["compaction"]);
    },
  );

  it.each(responseConverters)(
    "$name does not replay or prune across a different or missing request identity",
    ({ convert }) => {
      for (const identity of [
        { sessionId: "session-b", authProfileId: replayIdentity.authProfileId },
        { sessionId: replayIdentity.sessionId, authProfileId: "profile-b" },
        {},
      ]) {
        const assistant = createAssistant(
          [{ type: "text", text: "must remain without compatible replay" }],
          compactionState(model, { replayIndex: 0 }),
        );
        const input = convert({ messages: [assistant] }, identity);

        expect(input.some((item) => item.type === "compaction")).toBe(false);
        expect(JSON.stringify(input)).toContain("must remain without compatible replay");
      }
    },
  );

  it.each([
    ["provider", { provider: "other" }],
    ["model", { model: "other-model" }],
    ["API", { api: "openai-completions" as Api }],
    ["base route", { baseUrlHash: "0000000000000000" }],
  ])("does not replay across an incompatible %s", (_name, overrides) => {
    const assistant = createOutput();
    assistant.providerReplay = compactionState(model, overrides);
    const input = convertResponsesMessages(
      model,
      { messages: [{ role: "user", content: "first", timestamp: 1 }, assistant] },
      new Set(["openai"]),
      replayIdentity,
    );

    expect(input.some((item) => item.type === "compaction")).toBe(false);
  });

  it("does not fall back past a newer incompatible compaction item", () => {
    const compatible = createOutput();
    compatible.providerReplay = compactionState();
    const incompatible = createOutput();
    incompatible.providerReplay = compactionState(model, { model: "other-model" });

    const input = convertResponsesMessages(
      model,
      {
        messages: [
          compatible,
          { role: "user", content: "route changed", timestamp: 1 },
          incompatible,
        ],
      },
      new Set(["openai"]),
      replayIdentity,
    );

    expect(input.some((item) => item.type === "compaction")).toBe(false);
  });

  it.each(responseConverters)(
    "$name ignores a newer foreign-route suppression tombstone",
    ({ convert }) => {
      const compatible = createAssistant(
        [
          { type: "text", text: "pruned before compaction" },
          { type: "text", text: "retained after compaction" },
        ],
        compactionState(model, { replayIndex: 1 }),
      );
      const foreignSuppression = createAssistant([
        { type: "text", text: "foreign route recovered" },
      ]);
      suppressOpenAIResponsesCompaction(
        foreignSuppression,
        { ...model, baseUrl: "https://route-b.example/v1" },
        replayIdentity,
      );

      const input = convert({
        messages: [
          { role: "user", content: "pruned prefix", timestamp: 1 },
          compatible,
          { role: "user", content: "route B retry", timestamp: 2 },
          foreignSuppression,
          { role: "user", content: "current route A turn", timestamp: 3 },
        ],
      });

      expect(input.filter((item) => item.type === "compaction")).toEqual([
        expect.objectContaining({ id: "cmp_replay" }),
      ]);
      const encoded = JSON.stringify(input);
      expect(encoded).not.toContain("pruned prefix");
      expect(encoded).not.toContain("pruned before compaction");
      expect(encoded).toContain("retained after compaction");
      expect(encoded).toContain("foreign route recovered");
      expect(encoded).toContain("current route A turn");
    },
  );

  it("redacts encrypted compaction bytes from payload and event previews", () => {
    const secret = "opaque-preview-compaction";
    const value = { input: [{ type: "compaction", encrypted_content: secret }] };

    expect(stringifyRedactedPayload(value)).not.toContain(secret);
    expect(stringifyRedactedEvent(value)).not.toContain(secret);
    expect(stringifyRedactedPayload(value)).toContain("<opaque data omitted>");
  });
});
