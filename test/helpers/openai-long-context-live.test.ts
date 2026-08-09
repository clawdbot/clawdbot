import { describe, expect, it } from "vitest";
import {
  OPENAI_LONG_CONTEXT_LIVE_ENV,
  OPENAI_LONG_CONTEXT_METRICS_ENV,
  OPENAI_LONG_CONTEXT_PROFILE_ENV,
  OPENAI_LONG_OUTPUT_ENV,
  OPENAI_LONG_TOOL_BYTES_ENV,
  aggregateOpenAILongContextMetric,
  assertOpenAILongContextConfig,
  buildLongOutputPrompt,
  buildOpenAILongContextConfig,
  buildToolOutputFixture,
  observeOpenAICompactionEntries,
  readOpenAITransportReplayEvidence,
  readToolOutputEvidence,
  resolveOpenAILongContextLiveSettings,
  validateLongOutput,
  type LongOutputMarkers,
  type OpenAILongContextProfile,
} from "./openai-long-context-live.js";

const TEST_KEY = "test-key-placeholder";

function enabledSettings(profile: "reduced" | "full" = "full") {
  const settings = resolveOpenAILongContextLiveSettings(
    {
      [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1",
      [OPENAI_LONG_CONTEXT_PROFILE_ENV]: profile,
      OPENAI_API_KEY: TEST_KEY,
    },
    true,
  );
  if (!settings.enabled) {
    throw new Error("expected enabled settings");
  }
  return settings;
}

describe("OpenAI long-context live settings", () => {
  it("stays disabled unless the dedicated gate is enabled", () => {
    expect(resolveOpenAILongContextLiveSettings({}, false)).toEqual({ enabled: false });
    expect(resolveOpenAILongContextLiveSettings({}, true)).toEqual({ enabled: false });
  });

  it("fails closed on incomplete gates, missing keys, and malformed profiles", () => {
    expect(() =>
      resolveOpenAILongContextLiveSettings({ [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1" }, false),
    ).toThrow("also requires OPENCLAW_LIVE_TEST=1");
    expect(() =>
      resolveOpenAILongContextLiveSettings(
        {
          [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1",
          [OPENAI_LONG_CONTEXT_PROFILE_ENV]: "full",
        },
        true,
      ),
    ).toThrow("requires OPENAI_API_KEY");
    expect(() =>
      resolveOpenAILongContextLiveSettings(
        {
          [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1",
          [OPENAI_LONG_CONTEXT_PROFILE_ENV]: "huge",
          OPENAI_API_KEY: TEST_KEY,
        },
        true,
      ),
    ).toThrow("must be reduced or full");
  });

  it.each(["true", "yes", "2", "-1"])('rejects malformed suite flag "%s"', (raw) => {
    expect(() =>
      resolveOpenAILongContextLiveSettings(
        {
          [OPENAI_LONG_CONTEXT_LIVE_ENV]: raw,
        },
        true,
      ),
    ).toThrow("must be exactly 0 or 1");
  });

  it.each([OPENAI_LONG_CONTEXT_METRICS_ENV, OPENAI_LONG_OUTPUT_ENV])(
    "rejects malformed %s flag",
    (name) => {
      expect(() =>
        resolveOpenAILongContextLiveSettings(
          {
            [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1",
            [OPENAI_LONG_CONTEXT_PROFILE_ENV]: "reduced",
            [name]: "true",
            OPENAI_API_KEY: TEST_KEY,
          },
          true,
        ),
      ).toThrow("must be exactly 0 or 1");
    },
  );

  it.each(["3e5", "0x493e0", "300000.5", "-300000", "299999", "800001", "junk"])(
    'rejects malformed tool output bytes "%s"',
    (raw) => {
      expect(() =>
        resolveOpenAILongContextLiveSettings(
          {
            [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1",
            [OPENAI_LONG_CONTEXT_PROFILE_ENV]: "reduced",
            [OPENAI_LONG_TOOL_BYTES_ENV]: raw,
            OPENAI_API_KEY: TEST_KEY,
          },
          true,
        ),
      ).toThrow();
    },
  );

  it("resolves immutable reduced and full geometry plus strict optional flags", () => {
    expect(enabledSettings("reduced").profile).toMatchObject({
      modelRef: "openai/gpt-5.6-luna",
      contextWindow: 48_000,
      contextTokens: 48_000,
      maxTokens: 8_192,
      compactThreshold: 32_000,
    });
    const full = resolveOpenAILongContextLiveSettings(
      {
        [OPENAI_LONG_CONTEXT_LIVE_ENV]: "1",
        [OPENAI_LONG_CONTEXT_PROFILE_ENV]: "full",
        [OPENAI_LONG_CONTEXT_METRICS_ENV]: "1",
        [OPENAI_LONG_OUTPUT_ENV]: "1",
        [OPENAI_LONG_TOOL_BYTES_ENV]: "700000",
        OPENAI_API_KEY: TEST_KEY,
      },
      true,
    );
    expect(full).toMatchObject({
      enabled: true,
      emitMetrics: true,
      runLongOutput: true,
      toolOutputBytes: 700_000,
      profile: {
        modelRef: "openai/gpt-5.6-sol",
        contextWindow: 1_050_000,
        contextTokens: 922_000,
        maxTokens: 128_000,
        compactThreshold: 700_000,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        runtime: "openclaw",
      },
    });
  });
});

describe("OpenAI long-context config validation", () => {
  it("accepts the exact full route before Gateway startup", () => {
    const { profile } = enabledSettings("full");
    const cfg = buildOpenAILongContextConfig({
      profile,
      workspace: "/isolated/workspace",
      agentId: "long-context",
    });
    expect(() => assertOpenAILongContextConfig(cfg, profile)).not.toThrow();
  });

  it.each([
    ["model", (profile: OpenAILongContextProfile) => ({ ...profile, modelId: "gpt-wrong" })],
    ["runtime", (profile: OpenAILongContextProfile) => ({ ...profile, runtime: "codex" })],
    ["window", (profile: OpenAILongContextProfile) => ({ ...profile, contextWindow: 272_000 })],
    [
      "context cap",
      (profile: OpenAILongContextProfile) => ({ ...profile, contextTokens: 272_000 }),
    ],
    [
      "threshold",
      (profile: OpenAILongContextProfile) => ({ ...profile, compactThreshold: 735_000 }),
    ],
  ])("rejects a full-profile %s mismatch", (_name, mutate) => {
    const { profile } = enabledSettings("full");
    const cfg = buildOpenAILongContextConfig({
      profile,
      workspace: "/isolated/workspace",
      agentId: "long-context",
    });
    expect(() =>
      assertOpenAILongContextConfig(cfg, mutate(profile) as OpenAILongContextProfile),
    ).toThrow("config mismatch");
  });
});

describe("OpenAI compaction state observation", () => {
  it("returns only stable hashes and fence metadata", () => {
    const providerReplay = {
      v: 1,
      type: "openai-responses-compaction",
      id: "cmp-secret-id",
      data: "opaque-ciphertext-secret",
      replayIndex: 2,
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.6-sol",
      baseUrlHash: "route-fence",
      sessionHash: "session-fence",
      authProfileHash: "auth-fence",
    };
    const message = { role: "assistant", providerReplay };
    const observation = observeOpenAICompactionEntries({
      persistedEntries: [{ type: "message", message }],
      activeMessages: [message],
    });

    expect(observation).toMatchObject({
      persistedCount: 1,
      activeCount: 1,
      latest: {
        type: "openai-responses-compaction",
        replayIndex: 2,
        provider: "openai",
        model: "gpt-5.6-sol",
        baseUrlHash: "route-fence",
      },
    });
    expect(observation.latest?.idHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(observation.latest?.payloadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(observation)).not.toContain(providerReplay.id);
    expect(JSON.stringify(observation)).not.toContain(providerReplay.data);
  });

  it("distinguishes abandoned persisted replay from active replay", () => {
    const message = {
      role: "assistant",
      providerReplay: {
        type: "openai-responses-compaction",
        data: "opaque",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.6-sol",
        baseUrlHash: "route",
      },
    };
    expect(
      observeOpenAICompactionEntries({
        persistedEntries: [{ type: "message", message }],
        activeMessages: [],
      }),
    ).toEqual({ persistedCount: 1, activeCount: 0 });
  });
});

describe("OpenAI redacted request evidence", () => {
  it("parses priority and exact replay identities without payload bytes", () => {
    const idHash = "a".repeat(64);
    const payloadHash = "b".repeat(64);
    const requestHash = "sha256:75620e64157af5a8925a20049b210540e40ed183a34f4c59aa4c53d80d1f2fbc";
    const logs =
      `[responses] start provider=openai api=openai-responses model=gpt-5.6-sol ` +
      `requestIdHash=${requestHash} ` +
      `fields=context_management,input,model,service_tier serviceTier=priority ` +
      `inputItems=6 inputItemShape=message:developer,compaction,reasoning,message:assistant,function_call,message:user ` +
      `compactionItems=1 compactionIdHashes=${idHash} compactionPayloadHashes=${payloadHash} ` +
      `compactionInputIndexes=1 store=true`;
    expect(readOpenAITransportReplayEvidence(logs, "gpt-5.6-sol", "run-1:model:1")).toEqual({
      serviceTier: "priority",
      inputItems: 6,
      inputItemShape: [
        "message:developer",
        "compaction",
        "reasoning",
        "message:assistant",
        "function_call",
        "message:user",
      ],
      compactionItems: 1,
      compactionIdHashes: [idHash],
      compactionPayloadHashes: [payloadHash],
      compactionInputIndexes: [1],
      contextManagement: true,
    });
  });

  it("selects the Gateway inference instead of a later local-compaction request", () => {
    const replayHash = "c".repeat(64);
    const primaryRequestHash =
      "sha256:e21fa95e98fd8d8583028e5c0a6ac464a44a83a013f98741fa73f78f7d4ea655";
    const compactionRequestHash =
      "sha256:36170368744f50b28531933973e732b8b883ca9b7d993dd5ff41363bbcf76b20";
    const logs = [
      `[responses] start provider=openai api=openai-responses model=gpt-5.6-luna ` +
        `requestIdHash=${primaryRequestHash} fields=context_management,input,model,service_tier ` +
        `serviceTier=priority inputItems=3 inputItemShape=message:developer,compaction,message:user ` +
        `compactionItems=1 compactionIdHashes=none ` +
        `compactionPayloadHashes=${replayHash} compactionInputIndexes=1 store=true`,
      `[responses] start provider=openai api=openai-responses model=gpt-5.6-luna ` +
        `requestIdHash=${compactionRequestHash} fields=input,model,service_tier ` +
        `serviceTier=priority inputItems=1 inputItemShape=message:user ` +
        `compactionItems=0 compactionIdHashes=none ` +
        `compactionPayloadHashes=none compactionInputIndexes=none store=true`,
    ].join("\n");

    expect(readOpenAITransportReplayEvidence(logs, "gpt-5.6-luna", "run-2:model:1")).toMatchObject({
      compactionItems: 1,
      compactionPayloadHashes: [replayHash],
      compactionInputIndexes: [1],
      contextManagement: true,
    });
  });
});

describe("OpenAI mechanically generated output", () => {
  const markers: LongOutputMarkers = {
    begin: "OUTPUT-BEGIN",
    middle: "OUTPUT-MIDDLE",
    end: "OUTPUT-END",
  };
  const totalLines = 384;
  const lines = Array.from({ length: totalLines }, (_, offset) => {
    const index = offset + 1;
    const number = String(index).padStart(4, "0");
    if (index === 1) {
      return `${number}|BEGIN|${markers.begin}`;
    }
    if (index === totalLines / 2) {
      return `${number}|MIDDLE|${markers.middle}`;
    }
    if (index === totalLines) {
      return `${number}|END|${markers.end}`;
    }
    return `${number}|BODY|red orange yellow green blue indigo violet`;
  });

  it("accepts exact CRLF output with a single terminal newline", () => {
    expect(
      validateLongOutput({
        text: `${lines.join("\r\n")}\r\n`,
        markers,
        outputTokens: 5_200,
        stopReason: "stop",
      }),
    ).toEqual({ lineCount: 384, chars: lines.join("\n").length });
    expect(buildLongOutputPrompt(markers)).toContain("0384|END|OUTPUT-END");
  });

  it.each([
    ["missing line", lines.slice(1).join("\n"), 5_200, "stop"],
    ["extra prose", `${lines.join("\n")}\nextra`, 5_200, "stop"],
    ["wrong marker", lines.join("\n").replace(markers.middle, "WRONG"), 5_200, "stop"],
    ["too few tokens", lines.join("\n"), 4_095, "stop"],
    ["too many tokens", lines.join("\n"), 8_193, "stop"],
    ["length stop", lines.join("\n"), 5_200, "length"],
  ])("rejects %s", (_name, text, outputTokens, stopReason) => {
    expect(() => validateLongOutput({ text, markers, outputTokens, stopReason })).toThrow();
  });
});

describe("OpenAI deterministic large tool output", () => {
  it("creates exact bounded fixture bytes and validates redacted read evidence", () => {
    const fixture = buildToolOutputFixture({ marker: "TOOL-MARKER", bytes: 512_000 });
    expect(fixture.bytes).toBe(512_000);
    expect(fixture.content).toContain("TOOL-MARKER");
    const events = [
      {
        stream: "tool",
        data: {
          phase: "start",
          name: "read",
          toolCallId: "call-secret",
          args: { file_path: "/tmp/workspace/.openclaw/tmp/tool-output.txt" },
        },
      },
      {
        stream: "tool",
        data: {
          phase: "result",
          name: "read",
          toolCallId: "call-secret",
          isError: false,
          result: {
            content: [{ type: "text", text: "TOOL-MARKER|BEGIN|000000\nPRIVATE-TOOL-CONTENT" }],
            details: {
              kind: "truncated",
              truncation: { truncated: true, totalBytes: 512_000 },
            },
          },
        },
      },
    ];
    const evidence = readToolOutputEvidence({
      events,
      expectedPath: ".openclaw/tmp/tool-output.txt",
      expectedMarker: "TOOL-MARKER",
      expectedBytes: fixture.bytes,
      fixtureHash: fixture.sha256,
    });
    expect(evidence).toMatchObject({
      path: ".openclaw/tmp/tool-output.txt",
      marker: "TOOL-MARKER",
      originalBytes: 512_000,
      fixtureHash: fixture.sha256,
    });
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE-TOOL-CONTENT");
    expect(JSON.stringify(evidence)).not.toContain("call-secret");
  });

  it("rejects wrong path, size, or marker evidence", () => {
    const fixture = buildToolOutputFixture({ marker: "TOOL-MARKER", bytes: 300_000 });
    expect(() =>
      readToolOutputEvidence({
        events: [],
        expectedPath: "missing.txt",
        expectedMarker: fixture.marker,
        expectedBytes: fixture.bytes,
        fixtureHash: fixture.sha256,
      }),
    ).toThrow("did not start");
  });
});

describe("OpenAI turn metrics", () => {
  it("aggregates normalized last-call usage and keeps unavailable fields explicit", () => {
    const { profile } = enabledSettings("full");
    expect(
      aggregateOpenAILongContextMetric({
        profile,
        phase: "dense-2",
        inputChars: 900_000,
        elapsedMs: 12_345,
        ttfaMs: 420,
        agentMeta: {
          contextTokens: 922_000,
          promptTokens: 300_000,
          lastCallUsage: {
            input: 250_000,
            output: 25,
            cacheRead: 50_000,
            cacheWrite: 0,
            total: 300_025,
          },
        },
        serviceTier: "priority",
        compactionCount: 1,
        markerStatus: { begin: true, middle: true, end: true },
      }),
    ).toEqual({
      runtime: "openclaw",
      model: "openai/gpt-5.6-sol",
      phase: "dense-2",
      inputChars: 900_000,
      elapsedMs: 12_345,
      ttfaMs: 420,
      inputTokens: 250_000,
      outputTokens: 25,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 0,
      totalTokens: 300_025,
      promptTokens: 300_000,
      contextTokens: 922_000,
      effectiveWindow: 922_000,
      serviceTier: "priority",
      compactionCount: 1,
      compactionDurationMs: null,
      restartLatencyMs: null,
      markerStatus: { begin: true, middle: true, end: true },
    });
  });
});
