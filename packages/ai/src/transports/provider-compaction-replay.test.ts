import type { AssistantMessage, Context, Model, ProviderReplayState } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  createCompactionCapture,
  buildAnthropicReplayPlan,
} from "./anthropic-compaction-replay.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
  suppressOpenAIResponsesCompaction,
} from "./openai-responses-compaction-replay.js";
import type { OpenAIResponsesCompactionOutput } from "./openai-responses-compaction-window.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";
import {
  CompactionReplayRefreshRequiredError,
  preserveCompactionReplayWindow,
  replaceCompactionReplayOwnerContent,
  requiresCompactionReplayRefresh,
  resolveCompactionReplayEligibility,
  resolveCompactionReplayPressure,
} from "./provider-compaction-replay.js";

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

function createAssistant(
  content: AssistantMessage["content"],
  replayIndex: number,
): AssistantMessage {
  const replayContext = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
  return {
    role: "assistant",
    content,
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
    stopReason: "toolUse",
    timestamp: 0,
    providerReplay: {
      v: 1,
      type: "openai-responses-compaction",
      id: "cmp_replay",
      data: "opaque-replay-compaction",
      replayIndex,
      provider: replayContext.provider,
      api: replayContext.api,
      model: replayContext.model,
      baseUrlHash: replayContext.baseUrlHash,
      sessionHash: replayContext.sessionHash,
      authProfileHash: replayContext.authProfileHash,
    } satisfies ProviderReplayState,
  };
}

describe("compaction replay owner rewrites", () => {
  it("keeps a reindexed call paired with its output", () => {
    const toolCall = { type: "toolCall" as const, id: "call_1", name: "read", arguments: {} };
    const owner = createAssistant([{ type: "text", text: "" }, toolCall], 1);
    const reindexed = replaceCompactionReplayOwnerContent(owner, [toolCall]);
    const input = convertResponsesMessages(
      model,
      {
        messages: [
          reindexed,
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "ok" }],
            isError: false,
            timestamp: 1,
          },
        ],
      },
      new Set(["openai"]),
      replayIdentity,
    );

    expect(reindexed.providerReplay?.replayIndex).toBe(0);
    expect(input.map((item) => item.type)).toEqual([
      "compaction",
      "function_call",
      "function_call_output",
    ]);
  });

  it("falls back to full history when owner content is emptied", () => {
    const stripped = replaceCompactionReplayOwnerContent(
      createAssistant([{ type: "text", text: "removed" }], 0),
      [],
    );
    const input = convertResponsesMessages(
      model,
      {
        messages: [
          { role: "user", content: "full history prefix", timestamp: 1 },
          stripped,
          { role: "user", content: "current turn", timestamp: 2 },
        ],
      },
      new Set(["openai"]),
      replayIdentity,
    );

    expect(stripped.providerReplay).toBeUndefined();
    expect(input.some((item) => item.type === "compaction")).toBe(false);
    expect(JSON.stringify(input)).toContain("full history prefix");
  });

  it("keeps a compaction-only checkpoint through an unchanged empty-content projection", () => {
    const owner = createAssistant([], 0);
    const projected = replaceCompactionReplayOwnerContent(owner, []);

    expect(projected.providerReplay).toBe(owner.providerReplay);
  });

  it("keeps retained-user checkpoints independent of owner content indexes", () => {
    const retained = createAssistant([{ type: "text", text: "removed owner output" }], 0);
    const providerReplay = retained.providerReplay;
    if (!providerReplay) {
      throw new Error("expected replay state");
    }
    retained.providerReplay = {
      ...providerReplay,
      type: "openai-responses-retained-compaction",
    };
    delete retained.providerReplay.replayIndex;

    const rewritten = replaceCompactionReplayOwnerContent(retained, []);

    expect(rewritten.providerReplay).toMatchObject({
      type: "openai-responses-retained-compaction",
      data: "opaque-replay-compaction",
    });
    expect(rewritten.providerReplay).not.toHaveProperty("replayIndex");
  });
});

describe("bounded compaction replay projection", () => {
  const latest: Context["messages"][number] = { role: "user", content: "latest", timestamp: 10 };

  it("projects only the newest evicted owner without old content or source mutation", () => {
    const prelude = { role: "user" as const, content: "covered history prelude", timestamp: 0 };
    const old = createAssistant([{ type: "text", text: "older owner" }], 1);
    captureOpenAIResponsesCompaction(
      old,
      { type: "compaction", encrypted_content: "older opaque state" },
      1,
      model,
      buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity),
    );
    const newest = createAssistant([{ type: "text", text: "covered owner" }], 1);
    const replay = newest.providerReplay;
    const source = [prelude, old, newest, latest];
    const projected = preserveCompactionReplayWindow(
      source,
      [prelude, latest],
      model,
      replayIdentity,
    );
    expect(projected[0]).toMatchObject({ content: [], providerReplay: { replayIndex: 0 } });
    expect(newest.providerReplay).toBe(replay);
    expect(newest.providerReplay?.replayIndex).toBe(1);
    expect(newest.content).toEqual([{ type: "text", text: "covered owner" }]);
    expect(preserveCompactionReplayWindow(projected, projected, model, replayIdentity)).toBe(
      projected,
    );
    const input = convertResponsesMessages(
      model,
      { messages: projected },
      new Set(["openai"]),
      replayIdentity,
    );
    expect(input[0]).toMatchObject({
      type: "compaction",
      encrypted_content: "opaque-replay-compaction",
    });
    const pressure = resolveCompactionReplayPressure(projected, model, replayIdentity, estimator);
    expect({
      wireContainsCoveredPrelude: JSON.stringify(input).includes(prelude.content),
      pressureContainsCoveredPrelude: JSON.stringify(pressure?.messages).includes(prelude.content),
    }).toEqual({ wireContainsCoveredPrelude: false, pressureContainsCoveredPrelude: false });
    expect(pressure?.prefixTokens).toBe("opaque-replay-compaction".length);
    expect(projected).toHaveLength(2);
    expect(JSON.stringify(input)).not.toContain("owner");
  });

  it("does not project when the owner is retained, even after earlier source entries", () => {
    const owner = createAssistant([{ type: "text", text: "covered" }], 1);
    const source = [latest, owner];
    expect(preserveCompactionReplayWindow(source, source, model, replayIdentity)).toBe(source);
    expect(preserveCompactionReplayWindow(source, [owner], model, replayIdentity)).toEqual([owner]);
  });

  it.each([
    "azure-openai-responses",
    "openai-chatgpt-responses",
    "openclaw-openai-responses-transport",
  ])("preserves checkpoints on the %s Responses API route", (api) => {
    const route = { ...model, api };
    const owner = createAssistant([{ type: "text", text: "covered" }], 1);
    captureOpenAIResponsesCompaction(
      owner,
      { type: "compaction", encrypted_content: "route checkpoint" },
      1,
      route,
      buildOpenAIResponsesReasoningReplayMetadata(route, replayIdentity),
    );
    const projected = preserveCompactionReplayWindow(
      [owner, latest],
      [latest],
      route,
      replayIdentity,
    );
    expect(
      convertResponsesMessages(
        route,
        { messages: projected },
        new Set(["openai"]),
        replayIdentity,
      )[0],
    ).toMatchObject({ type: "compaction", encrypted_content: "route checkpoint" });
    expect(
      resolveCompactionReplayPressure(projected, route, replayIdentity, estimator)?.prefixTokens,
    ).toBe("route checkpoint".length);
  });

  it.each(["malformed", "mismatched", "suppressed"])("honors the newest %s barrier", (kind) => {
    const old = createAssistant([], 0);
    const barrier = createAssistant([], 0);
    if (!barrier.providerReplay) {
      throw new Error("missing replay state");
    }
    if (kind === "malformed") {
      barrier.providerReplay = { ...barrier.providerReplay, data: "" };
    } else if (kind === "mismatched") {
      barrier.providerReplay = { ...barrier.providerReplay, model: "different-model" };
    } else {
      suppressOpenAIResponsesCompaction(barrier, model, replayIdentity);
    }
    const windowed = [latest];
    expect(
      preserveCompactionReplayWindow([old, barrier, latest], windowed, model, replayIdentity),
    ).toBe(windowed);
    expect(
      resolveCompactionReplayPressure([old, barrier, latest], model, replayIdentity, estimator),
    ).toBeUndefined();
  });

  it("keeps missing retained-user windows as refresh barriers without an invented index", () => {
    const owner = createAssistant([], 0);
    if (!owner.providerReplay) {
      throw new Error("missing replay state");
    }
    const { replayIndex: _index, ...replay } = owner.providerReplay;
    owner.providerReplay = { ...replay, type: "openai-responses-retained-compaction" };
    const projected = preserveCompactionReplayWindow(
      [owner, latest],
      [latest],
      model,
      replayIdentity,
    );
    expect(projected[0]).toMatchObject({
      providerReplay: { type: "openai-responses-retained-compaction" },
    });
    expect(projected[0]).not.toHaveProperty("providerReplay.replayIndex");
    expect(requiresCompactionReplayRefresh(projected, model, replayIdentity)).toBe(true);
    expect(() =>
      resolveCompactionReplayPressure(projected, model, replayIdentity, estimator),
    ).toThrow(CompactionReplayRefreshRequiredError);
  });

  it.each(["anthropic-messages", "openclaw-anthropic-messages-transport"])(
    "projects %s summaries through their own replay owner",
    (api) => {
      const anthropic = {
        ...model,
        api,
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        baseUrl: "https://api.anthropic.com/v1",
      } satisfies Model;
      const owner = createAssistant([{ type: "text", text: "covered" }], 1);
      const capture = createCompactionCapture(owner, anthropic, replayIdentity);
      capture.begin(0, { type: "compaction", content: "complete summary" }, 1);
      capture.complete(0);
      const projected = preserveCompactionReplayWindow([owner, latest], [latest], anthropic, {
        ...replayIdentity,
        enabled: true,
      });
      expect(
        buildAnthropicReplayPlan(projected, anthropic, { ...replayIdentity, enabled: true })
          .compaction,
      ).toEqual({ type: "compaction", content: "complete summary" });
      expect(
        resolveCompactionReplayPressure(
          projected,
          anthropic,
          { ...replayIdentity, enabled: true },
          estimator,
        )?.prefixTokens,
      ).toBe("complete summary".length);
    },
  );

  it.each([false, undefined])(
    "does not use Anthropic checkpoints without enabled replay: %s",
    (enabled) => {
      const anthropic = {
        ...model,
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      };
      const owner = createAssistant([{ type: "text", text: "covered" }], 1);
      const capture = createCompactionCapture(owner, anthropic, replayIdentity);
      capture.begin(0, { type: "compaction", content: "complete summary" }, 1);
      capture.complete(0);
      const identity = { ...replayIdentity, enabled };
      const window = [latest];
      expect(preserveCompactionReplayWindow([owner, latest], window, anthropic, identity)).toBe(
        window,
      );
      expect(
        resolveCompactionReplayPressure([owner, latest], anthropic, identity, estimator),
      ).toBeUndefined();
    },
  );
});

const estimator = {
  text: (value: string) => value.length,
  image: () => 100,
  json: (value: unknown) => JSON.stringify(value).length,
};

describe("prepared compaction replay eligibility", () => {
  const anthropic = {
    ...model,
    api: "anthropic-messages",
    provider: "anthropic",
    id: "claude-sonnet-4-6",
  };

  it.each([
    { apiKey: undefined, extraParams: { anthropicServerCompaction: true }, expected: false },
    { apiKey: "test-key", extraParams: {}, expected: false },
    { apiKey: "test-key", extraParams: { anthropicServerCompaction: true }, expected: true },
    {
      apiKey: "test-sk-ant-oat-fixture",
      extraParams: { anthropicServerCompaction: true },
      expected: false,
    },
  ])("requires known eligible authentication and opt-in: $expected", ({ expected, ...options }) => {
    expect(resolveCompactionReplayEligibility(anthropic, options)).toBe(expected);
  });

  it("keeps Responses checkpoint replay independent of new compaction generation", () => {
    expect(
      resolveCompactionReplayEligibility(model, {
        extraParams: { responsesServerCompaction: false },
      }),
    ).toBe(true);
    const owner = createAssistant([], 0);
    expect(
      resolveCompactionReplayPressure(
        [owner],
        model,
        { ...replayIdentity, enabled: false },
        estimator,
      ),
    ).toBeUndefined();
  });
});

describe("canonical compaction replay pressure", () => {
  it.each([
    { provider: "other-provider" },
    { api: "openai-completions" },
    { model: "other-model" },
  ])("does not trust later usage from a different route: %j", (route) => {
    const owner = createAssistant([], 0);
    const later = { ...createAssistant([{ type: "text", text: "later" }], 0), ...route };
    delete later.providerReplay;
    later.usage.contextUsage = { state: "available", promptTokens: 100, totalTokens: 101 };
    later.usage.totalTokens = 101;
    const plan = resolveCompactionReplayPressure([owner, later], model, replayIdentity, estimator);
    expect(plan?.messages[1]).not.toHaveProperty("usage.contextUsage");
    expect(plan?.messages[1]).toMatchObject({
      content: later.content,
      usage: { totalTokens: 101, cost: later.usage.cost },
    });
    expect(later.usage.contextUsage.totalTokens).toBe(101);
  });

  it("counts the returned prefix once after restart and an auth A to B to A round trip", () => {
    const owner = createAssistant([{ type: "text", text: "covered" }], 1);
    const output = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "canonical" }] },
      { type: "compaction", encrypted_content: "opaque" },
    ] satisfies OpenAIResponsesCompactionOutput;
    captureOpenAIResponsesCompaction(
      owner,
      { type: "compaction", encrypted_content: "opaque" },
      "retained-users",
      model,
      buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity),
      output,
    );
    const later = createAssistant([{ type: "text", text: "later" }], 0);
    delete later.providerReplay;
    owner.usage.contextUsage = { state: "available", promptTokens: 90_000, totalTokens: 90_001 };
    later.usage.contextUsage = { state: "available", promptTokens: 2_000, totalTokens: 2_001 };
    const source: Context["messages"] = [
      { role: "user", content: "raw".repeat(100_000), timestamp: 1 },
      owner,
    ];
    const requestB = convertResponsesMessages(model, { messages: source }, new Set(["openai"]), {
      ...replayIdentity,
      authProfileId: "profile-b",
    });
    expect(requestB.some((item) => item.type === "compaction")).toBe(false);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise persisted JSON reload, not an in-memory clone.
    const resumed: Context["messages"] = JSON.parse(JSON.stringify([...source, later]));
    const requestA = convertResponsesMessages(
      model,
      { messages: resumed },
      new Set(["openai"]),
      replayIdentity,
    );
    expect(requestA.slice(0, output.length)).toEqual(output);
    const plan = resolveCompactionReplayPressure(resumed, model, replayIdentity, estimator);
    expect(plan?.prefixTokens).toBe(
      "canonical".length +
        "opaque".length +
        estimator.json({ type: "message", role: "user" }) +
        estimator.json({ type: "input_text" }) +
        estimator.json({ type: "compaction" }),
    );
    expect(plan?.messages).toHaveLength(2);
    expect(plan?.messages[0]).toMatchObject({ content: [] });
    expect(plan?.messages[0]).not.toHaveProperty("usage.contextUsage");
    expect(plan?.messages[1]).not.toHaveProperty("usage.contextUsage");
    expect(plan?.messages[1]).toMatchObject({
      content: later.content,
      usage: { cost: later.usage.cost },
    });
    expect(owner.usage.contextUsage.totalTokens).toBe(90_001);
    expect(later.usage.contextUsage.totalTokens).toBe(2_001);
  });

  it("accounts for image metadata and file data without charging base64 image bytes twice", () => {
    const owner = createAssistant([], 0);
    const image = {
      type: "input_image" as const,
      detail: "high" as const,
      image_url:
        "data:image/jpeg;base64," +
        Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10_000)]).toString("base64"),
    };
    const remoteImage = { ...image, image_url: "https://media.example/image.png?signature=test" };
    const file = { type: "input_file" as const, file_data: "file-data", filename: "source.txt" };
    const output: OpenAIResponsesCompactionOutput = [
      { type: "message", role: "user", content: [image, remoteImage, file] },
      { type: "compaction", encrypted_content: "opaque" },
    ];
    captureOpenAIResponsesCompaction(
      owner,
      { type: "compaction", encrypted_content: "opaque" },
      "retained-users",
      model,
      buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity),
      output,
    );
    const plan = resolveCompactionReplayPressure([owner], model, replayIdentity, estimator);
    expect(plan?.prefixTokens).toBe(
      200 +
        estimator.json({ type: "input_image", detail: "high" }) +
        estimator.json(remoteImage) +
        estimator.json(file) +
        estimator.json({ type: "message", role: "user" }) +
        estimator.json({ type: "compaction" }) +
        "opaque".length,
    );
  });
});
