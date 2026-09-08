// Coverage for prompt-cache diagnostic tracking across turns.
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { Type } from "typebox";
import { beforeEach, describe, expect, it } from "vitest";
import {
  beginPromptCacheObservation,
  collectPromptCacheTools,
  completePromptCacheObservation,
  recordAggregateTruncation,
} from "./prompt-cache-observability.js";
import { createPromptCacheRequestObserver } from "./prompt-cache-request-observer.js";

let testScope = 0;
let currentTestScope = "";

function scopedKey(value: string): string {
  return `${value}:${currentTestScope}`;
}

describe("prompt cache observability", () => {
  beforeEach(() => {
    currentTestScope = String(++testScope);
  });

  it.each([
    {
      name: "three healthy calls then one",
      turns: [[10_000, 10_000, 10_000], [10_000]],
      misses: [],
    },
    {
      name: "one call then a miss and two hits",
      turns: [[10_000], [0, 10_000, 10_000]],
      misses: ["2:1"],
    },
    { name: "a complete miss below the drop threshold", turns: [[500], [0]], misses: ["2:1"] },
  ])("observes each request: $name", ({ turns, misses }) => {
    const sessionId = scopedKey("request-usage");
    const observed: Array<{ request: string; cacheRead: number | undefined; broke: boolean }> = [];
    for (const [turnIndex, reads] of turns.entries()) {
      const observer = createPromptCacheRequestObserver(
        { sessionId, streamStrategy: "test" },
        (observation) =>
          observed.push({
            request: `${turnIndex + 1}:${observation.requestIndex}`,
            cacheRead: observation.cacheRead,
            broke: observation.broke,
          }),
      );
      for (const cacheRead of reads) {
        observer.onModelRequest(
          { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" },
          {
            systemPrompt: "stable prefix",
            tools: [{ name: "read", description: "Read text", parameters: Type.Object({}) }],
          },
        );
        observer.onModelUsage({ input: 10_000 - cacheRead, cacheRead, cacheWrite: 0 });
      }
    }
    expect(observed.map((entry) => entry.cacheRead)).toEqual(turns.flat());
    expect(observed.filter((entry) => entry.broke).map((entry) => entry.request)).toEqual(misses);
  });

  it.each([false, true])(
    "keeps small complete misses tied to the last reported fingerprint (changed=%s)",
    (changed) => {
      const sessionId = scopedKey("small-cache-miss");
      const begin = (systemPrompt: string) =>
        beginPromptCacheObservation({
          sessionId,
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          streamStrategy: "test",
          systemPrompt,
          tools: [],
        });
      begin("prefix A");
      completePromptCacheObservation({ sessionId, usage: { cacheRead: 500 } });
      if (changed) {
        begin("prefix B");
        completePromptCacheObservation({ sessionId });
      }
      recordAggregateTruncation({ sessionId });
      begin(changed ? "prefix B" : "prefix A");
      const result = completePromptCacheObservation({
        sessionId,
        usage: { input: 500, cacheRead: 0 },
      });
      if (changed) {
        expect(result).toBeNull();
      } else {
        expect(result).toMatchObject({
          previousCacheRead: 500,
          cacheRead: 0,
          changes: [{ code: "aggregateToolResultTruncation" }],
        });
      }
    },
  );

  it("collects canonical trimmed tool snapshots", () => {
    expect(
      collectPromptCacheTools([{ name: "write" }, { name: "" }, {}, { name: " read " }]),
    ).toEqual([{ name: "read" }, { name: "write" }]);
  });

  it("collects prompt-cache tools without aborting on unreadable descriptors", () => {
    const unreadableTool = {
      get name(): string {
        throw new Error("tool name getter exploded");
      },
    };

    expect(
      collectPromptCacheTools([{ name: " read " }, unreadableTool, { name: "write" }]),
    ).toEqual([{ name: "read" }, { name: "write" }]);
  });

  it("fingerprints tool descriptions and schemas without retaining their content", () => {
    const first = collectPromptCacheTools([
      {
        name: "read",
        description: "Read a text file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    const changedDescription = collectPromptCacheTools([
      {
        name: "read",
        description: "Read a workspace file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    const changedSchema = collectPromptCacheTools([
      {
        name: "read",
        description: "Read a text file",
        parameters: { type: "object", properties: { path: { type: "number" } } },
      },
    ]);

    expect(first[0]).toEqual({
      name: "read",
      descriptionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(first[0]?.descriptionDigest).not.toBe(changedDescription[0]?.descriptionDigest);
    expect(first[0]?.schemaDigest).not.toBe(changedSchema[0]?.schemaDigest);
  });

  it("fingerprints own __proto__ schema properties without prototype pollution", () => {
    const collectSchema = (properties: Record<string, unknown>) =>
      collectPromptCacheTools([
        {
          name: "read",
          parameters: { type: "object", properties },
        },
      ]);
    const stringPrototype = collectSchema({
      ["__proto__"]: { type: "string" },
    });
    const numberPrototype = collectSchema({
      ["__proto__"]: { type: "number" },
    });
    const noPrototype = collectSchema({});

    expect(stringPrototype[0]?.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(stringPrototype[0]?.schemaDigest).not.toBe(numberPrototype[0]?.schemaDigest);
    expect(stringPrototype[0]?.schemaDigest).not.toBe(noPrototype[0]?.schemaDigest);
    expect(numberPrototype[0]?.schemaDigest).not.toBe(noPrototype[0]?.schemaDigest);
  });

  it("bounds hostile, circular, and unreadable schema fingerprints", () => {
    const circular: Record<string, unknown> = { type: "object" };
    circular.self = circular;
    const unreadable = {
      name: "unreadable",
      get parameters(): unknown {
        throw new Error("schema getter exploded");
      },
    };
    const oversized = {
      name: "oversized",
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 1_000 }, (_, index) => [
            `property_${String(index).padStart(4, "0")}`,
            { type: "string", description: "x".repeat(10_000) },
          ]),
        ),
      },
    };

    expect(
      collectPromptCacheTools([oversized, unreadable, { name: "circular", parameters: circular }]),
    ).toEqual([
      { name: "circular", schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { name: "oversized", schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { name: "unreadable", schemaDigest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
  });

  it("rejects wide schemas before reading values and ignores their insertion order", () => {
    let propertyReads = 0;
    const createWideSchema = (reversed: boolean) => {
      const properties: Record<string, unknown> = {};
      const names = Array.from(
        { length: 256 },
        (_, index) => `property_${String(index).padStart(4, "0")}`,
      );
      for (const name of reversed ? names.toReversed() : names) {
        Object.defineProperty(properties, name, {
          enumerable: true,
          get: () => {
            propertyReads += 1;
            return { type: "string" };
          },
        });
      }
      return { type: "object", properties };
    };

    const first = collectPromptCacheTools([{ name: "wide", parameters: createWideSchema(false) }]);
    const reversed = collectPromptCacheTools([
      { name: "wide", parameters: createWideSchema(true) },
    ]);

    expect(reversed).toEqual(first);
    expect(first[0]?.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(propertyReads).toBe(0);
  });

  it("tracks cache-relevant changes and reports a real cache-read drop", () => {
    // Observability only emits when a material cache-read drop follows a tracked
    // cache-affecting change.
    const first = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: scopedKey("agent:main"),
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "long",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "sse",
      systemPrompt: "stable system",
      tools: [{ name: "read" }, { name: "write" }],
    });

    expect(first.changes).toBeNull();
    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: scopedKey("agent:main"),
        usage: { cacheRead: 8_000 },
      }),
    ).toBeNull();

    const second = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: scopedKey("agent:main"),
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      tools: [{ name: "read" }, { name: "write" }],
    });

    expect(second.changes?.map((change) => change.code)).toEqual([
      "cacheRetention",
      "transport",
      "systemPrompt",
    ]);

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: scopedKey("agent:main"),
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: [
        { code: "cacheRetention", detail: "long -> short" },
        { code: "transport", detail: "sse -> websocket" },
        { code: "systemPrompt", detail: "system prompt digest changed" },
      ],
    });
  });

  it("suppresses cache-break events for small drops", () => {
    beginPromptCacheObservation({
      sessionId: scopedKey("session-1"),
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      tools: [{ name: "read" }],
    });
    completePromptCacheObservation({
      sessionId: scopedKey("session-1"),
      usage: { cacheRead: 5_000 },
    });

    beginPromptCacheObservation({
      sessionId: scopedKey("session-1"),
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      tools: [{ name: "read" }],
    });

    expect(
      completePromptCacheObservation({
        sessionId: scopedKey("session-1"),
        usage: { cacheRead: 4_600 },
      }),
    ).toBeNull();
  });

  it("treats reordered tool lists as the same diagnostics tool set", () => {
    // Tool list ordering is deterministic for payloads but should not create a
    // false cache-break diagnostic when the set is unchanged.
    beginPromptCacheObservation({
      sessionId: scopedKey("session-1"),
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      tools: [{ name: "read" }, { name: "write" }],
    });
    completePromptCacheObservation({
      sessionId: scopedKey("session-1"),
      usage: { cacheRead: 8_000 },
    });

    const second = beginPromptCacheObservation({
      sessionId: scopedKey("session-1"),
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      tools: [{ name: "write" }, { name: "read" }],
    });

    expect(second.changes).toBeNull();
  });

  it("ignores dynamic system prompt suffix changes after the cache boundary", () => {
    const sessionId = scopedKey("dynamic-system-suffix");
    const stablePrefix = "stable instructions and tool capability directory";
    beginPromptCacheObservation({
      sessionId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: `${stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}first turn context`,
      tools: [{ name: "read" }],
    });
    completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });

    const next = beginPromptCacheObservation({
      sessionId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: `${stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}second turn context`,
      tools: [{ name: "read" }],
    });

    expect(next.changes).toBeNull();
  });

  it("reports visible schema changes even when tool names and count are unchanged", () => {
    const sessionId = scopedKey("changed-tool-schema");
    const initialTools = collectPromptCacheTools([
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    beginPromptCacheObservation({
      sessionId,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      tools: initialTools,
    });
    completePromptCacheObservation({ sessionId, usage: { cacheRead: 8_000 } });

    const next = beginPromptCacheObservation({
      sessionId,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      tools: collectPromptCacheTools([
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "number" } } },
        },
      ]),
    });

    expect(next.changes).toEqual([{ code: "tools", detail: "tool set changed with same count" }]);
    expect(completePromptCacheObservation({ sessionId, usage: { cacheRead: 0 } })).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 0,
      changes: [{ code: "tools", detail: "tool set changed with same count" }],
    });
  });

  it("tracks recurring prompt-cache affinity across rotating session ids", () => {
    // Cron-style isolated runs use promptCacheKey to carry cache affinity across
    // new session ids.
    beginPromptCacheObservation({
      sessionId: "isolated-run-1",
      promptCacheKey: scopedKey("openclaw-cron-stable-cache-key"),
      sessionKey: "agent:cron:run:isolated-run-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      tools: [{ name: "read" }],
    });
    completePromptCacheObservation({
      sessionId: "isolated-run-1",
      promptCacheKey: scopedKey("openclaw-cron-stable-cache-key"),
      sessionKey: "agent:cron:run:isolated-run-1",
      usage: { cacheRead: 8_000 },
    });

    const nextRun = beginPromptCacheObservation({
      sessionId: "isolated-run-2",
      promptCacheKey: scopedKey("openclaw-cron-stable-cache-key"),
      sessionKey: "agent:cron:run:isolated-run-2",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      tools: [{ name: "read" }],
    });

    expect(nextRun.previousCacheRead).toBe(8_000);
    expect(nextRun.changes).toBeNull();
  });

  it("evicts old tracker entries when the tracker map grows past the soft cap", () => {
    beginPromptCacheObservation({
      sessionId: scopedKey("session-0"),
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      tools: [{ name: "read" }],
    });
    completePromptCacheObservation({
      sessionId: scopedKey("session-0"),
      usage: { cacheRead: 8_000 },
    });

    for (let index = 1; index <= 513; index += 1) {
      beginPromptCacheObservation({
        sessionId: scopedKey(`session-${index}`),
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        streamStrategy: "boundary-aware:openai-responses",
        systemPrompt: `stable system ${index}`,
        tools: [{ name: "read" }],
      });
    }

    const restarted = beginPromptCacheObservation({
      sessionId: scopedKey("session-0"),
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      tools: [{ name: "read" }],
    });

    expect(restarted.previousCacheRead).toBeNull();
    expect(restarted.changes).toBeNull();
  });

  it("ignores missing usage and preserves the previous cache-read baseline", () => {
    beginPromptCacheObservation({
      sessionId: scopedKey("session-1"),
      sessionKey: scopedKey("agent:main"),
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "long",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "sse",
      systemPrompt: "stable system",
      tools: [{ name: "read" }],
    });
    completePromptCacheObservation({
      sessionId: scopedKey("session-1"),
      sessionKey: scopedKey("agent:main"),
      usage: { cacheRead: 8_000 },
    });

    beginPromptCacheObservation({
      sessionId: scopedKey("session-1"),
      sessionKey: scopedKey("agent:main"),
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      tools: [{ name: "read" }],
    });

    expect(
      completePromptCacheObservation({
        sessionId: scopedKey("session-1"),
        sessionKey: scopedKey("agent:main"),
      }),
    ).toBeNull();

    const resumed = beginPromptCacheObservation({
      sessionId: scopedKey("session-1"),
      sessionKey: scopedKey("agent:main"),
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      tools: [{ name: "read" }],
    });

    expect(resumed.previousCacheRead).toBe(8_000);
    expect(resumed.changes).toBeNull();

    expect(
      completePromptCacheObservation({
        sessionId: scopedKey("session-1"),
        sessionKey: scopedKey("agent:main"),
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: null,
    });
  });
});
