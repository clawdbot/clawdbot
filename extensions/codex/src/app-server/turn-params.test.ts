import { resolveThinkingDefault } from "openclaw/plugin-sdk/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";
import { buildTurnStartParams } from "./turn-params.js";

afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
});

describe("buildTurnStartParams model thinking defaults", () => {
  it.each([
    { thinking: undefined, thinkingDefault: undefined, expected: "low" },
    { thinking: undefined, thinkingDefault: "high" as const, expected: "high" },
    { thinking: "medium", thinkingDefault: "high" as const, expected: "medium" },
  ])("sends $expected for Astra with configured effort $thinking/$thinkingDefault", (testCase) => {
    const modelId = "gpt-6-astra";
    const config = {
      agents: {
        defaults: {
          thinkingDefault: testCase.thinkingDefault,
          models: { [`openai/${modelId}`]: { params: { thinking: testCase.thinking } } },
        },
      },
    };
    const params = createParams("/tmp/session.jsonl", "/repo", config);
    params.provider = "openai";
    params.modelId = modelId;
    params.model = {
      ...params.model,
      provider: "openai",
      id: modelId,
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    };
    params.thinkLevel = resolveThinkingDefault({
      cfg: config,
      provider: params.provider,
      model: modelId,
      agentRuntime: "codex",
      catalog: [{ provider: "openai", id: modelId, name: "Astra", reasoning: true }],
    });

    const turn = buildTurnStartParams(params, {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions(),
    });
    expect(turn.effort).toBe(testCase.expected);
    expect(turn.collaborationMode?.settings.reasoning_effort).toBe(testCase.expected);
  });
});

describe("buildTurnStartParams temporal context", () => {
  it("uses the configured user timezone on every turn without changing cron input", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T00:30:00.000Z"));
    const params = createParams("/tmp/session.jsonl", "/repo", {
      agents: { defaults: { userTimezone: "America/Los_Angeles" } },
    });
    params.provider = "openai";
    params.modelId = "gpt-5.4";
    params.prompt = "run exactly";
    params.trigger = "cron";
    params.bootstrapContextMode = "lightweight";
    params.bootstrapContextRunKind = "cron";
    params.startedAtMs = Date.parse("2026-09-01T00:30:00.000Z");
    const options = {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions(),
      sessionStatusAvailable: true,
    };

    const firstTurn = buildTurnStartParams(params, options);
    expect(firstTurn.input).toEqual([{ type: "text", text: "run exactly", text_elements: [] }]);
    expect(firstTurn.additionalContext).toEqual({
      openclaw_source_delivery: {
        kind: "application",
        value: expect.stringContaining("reply normally in your final assistant message"),
      },
      openclaw_temporal_context: {
        kind: "application",
        value:
          "## Temporal Context\nCurrent date: 2026-09-01\nTime zone: America/Los_Angeles\nFor the exact current time, use `session_status`.",
      },
    });

    clock.mockReturnValue(Date.parse("2026-09-03T00:30:00.000Z"));
    const nextTurn = buildTurnStartParams(params, options);
    expect(nextTurn.input).toEqual(firstTurn.input);
    expect(nextTurn.additionalContext?.openclaw_temporal_context?.value).toContain(
      "Current date: 2026-09-02",
    );
  });

  it("emits the host fallback after a timezone override is removed", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-02T00:30:00.000Z"));
    const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim() || "UTC";
    const configuredTimezone =
      hostTimezone === "America/Los_Angeles" ? "Asia/Tokyo" : "America/Los_Angeles";
    const options = {
      threadId: "thread-1",
      cwd: "/repo",
      appServer: createAppServerOptions(),
      sessionStatusAvailable: false,
    };
    const configured = buildTurnStartParams(
      createParams("/tmp/session.jsonl", "/repo", {
        agents: { defaults: { userTimezone: configuredTimezone } },
      }),
      options,
    );
    const fallback = buildTurnStartParams(createParams("/tmp/session.jsonl", "/repo"), options);

    expect(configured.additionalContext?.openclaw_temporal_context?.value).toContain(
      `Time zone: ${configuredTimezone}`,
    );
    expect(fallback.additionalContext?.openclaw_temporal_context?.value).toContain(
      `Time zone: ${hostTimezone}`,
    );
    expect(fallback.additionalContext?.openclaw_temporal_context?.value).not.toContain(
      configuredTimezone,
    );
  });
});

describe("buildTurnStartParams source-delivery context", () => {
  it.each([false, true])(
    "carries explicit current policy without changing raw input (native settings=%s)",
    (preserveNativeTurnSettings) => {
      const params = createParams("/tmp/session.jsonl", "/repo");
      params.prompt = "unchanged current request";
      params.permissionChange = {
        owner: {},
        baseExecOverrides: {},
        notice: "Permission changed.",
        request: vi.fn(),
        applied: () => true,
        recordApplied: vi.fn(),
      };
      const options = {
        threadId: "thread-1",
        cwd: "/repo",
        appServer: createAppServerOptions(),
        messageToolAvailable: true,
        requireExplicitMessageTarget: false,
        preserveNativeTurnSettings,
      };
      const turns = (["automatic", "message_tool_only", undefined] as const).map((mode) =>
        buildTurnStartParams({ ...params, sourceReplyDeliveryMode: mode }, options),
      );
      const values = turns.map((turn) => turn.additionalContext?.openclaw_source_delivery?.value);
      expect(values[0]).toContain("OpenClaw delivers your final response automatically");
      expect(values[0]).toContain("sending a message doesn’t end your task");
      expect(values[1]).toContain("Use `message(action=send)`");
      expect(values[1]).toContain("For progress, set `final=false`");
      expect(values[1]).toContain("Set `final=true`, or omit it,");
      expect(values[1]).toContain("current source is default target");
      expect(values[2]).toBe(values[0]);
      for (const turn of turns) {
        expect(turn.input).toEqual([{ type: "text", text: params.prompt, text_elements: [] }]);
        expect(turn.additionalContext?.openclaw_temporal_context).toBeDefined();
        expect(turn.additionalContext?.openclaw_permission_change).toEqual({
          kind: "application",
          value: "Permission changed.",
        });
        expect(turn.additionalContext?.openclaw_source_delivery?.kind).toBe("application");
        expect(
          Buffer.byteLength(turn.additionalContext!.openclaw_source_delivery!.value, "utf8"),
        ).toBeLessThan(1_000);
        if (preserveNativeTurnSettings) {
          expect(turn).not.toHaveProperty("collaborationMode");
        }
      }
      const required = buildTurnStartParams(
        { ...params, sourceReplyDeliveryMode: "message_tool_only" },
        { ...options, requireExplicitMessageTarget: true },
      );
      expect(required.additionalContext?.openclaw_source_delivery?.value).toContain(
        "target required this turn",
      );
      const unavailable = buildTurnStartParams(
        { ...params, sourceReplyDeliveryMode: "message_tool_only" },
        { ...options, messageToolAvailable: false, requireExplicitMessageTarget: true },
      );
      expect(unavailable.additionalContext?.openclaw_source_delivery?.value).toContain(
        "remains private",
      );
      expect(unavailable.additionalContext?.openclaw_source_delivery?.value).not.toContain(
        "Use `message`",
      );
      expect(unavailable.additionalContext?.openclaw_source_delivery?.value).not.toContain(
        "target required",
      );
    },
  );
});
