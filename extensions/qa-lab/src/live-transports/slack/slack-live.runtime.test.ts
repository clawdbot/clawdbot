// Qa Lab tests cover slack live plugin behavior.
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { requireFlowScenario } from "../../scenario-catalog.test-utils.js";
import { resolveLiveTransportQaScenarioIds } from "../shared/scenario-selection.js";
import { testing as adapterTesting } from "./adapter.runtime.js";
import { resolveApprovalDecision } from "./slack-live.approvals.js";
import {
  quiesceCodexApprovalAgentRun,
  resolveCodexFileApprovalTargetPath,
  waitForSlackReaction,
} from "./slack-live.codex-approval.js";
import {
  buildSlackQaConfig,
  parseSlackQaCredentialPayload,
  resolveSlackQaRuntimeEnv,
} from "./slack-live.config.js";
import {
  assertSlackCodexApprovalModelSupported,
  type SlackQaScenarioImplementation,
} from "./slack-live.contracts.js";
import { buildSlackInvalidBlocksTableProbe } from "./slack-live.invalid-blocks.js";
import {
  observeSlackScenarioMessages,
  waitForSlackNoReply,
} from "./slack-live.message-observations.js";
import {
  buildSlackApprovalCheckpointMessage,
  collectSlackActionValues,
  extractSlackNativeApprovalId,
  runSlackTableInvalidBlocksFallbackScenario,
} from "./slack-live.observations.js";
import * as slackScenarioImplementations from "./slack-live.scenario-implementations.js";

function toSlackScenarioExportName(id: string): string {
  const suffix = id
    .replace(/^slack-/, "")
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
  return `slackQa${suffix}Scenario`;
}

function findScenario(ids?: string[]) {
  return resolveLiveTransportQaScenarioIds({
    channelId: "slack",
    providerMode: "live-frontier",
    scenarioIds: ids,
    supportsModuleFlows: true,
  }).map((id) => {
    const implementation = (
      slackScenarioImplementations as unknown as Record<string, SlackQaScenarioImplementation>
    )[toSlackScenarioExportName(id)];
    if (!implementation) {
      throw new Error(`missing Slack test implementation for ${id}`);
    }
    const scenario = requireFlowScenario(readQaScenarioById(id));
    return Object.assign({}, implementation, {
      id,
      timeoutMs: scenario.execution.timeoutMs ?? 60_000,
      title: scenario.title,
    });
  });
}

const testing = {
  assertSlackCodexApprovalModelSupported,
  buildSlackApprovalCheckpointMessage,
  buildSlackInvalidBlocksTableProbe,
  buildSlackQaConfig,
  collectSlackActionValues,
  extractSlackNativeApprovalId,
  findScenario,
  observeSlackScenarioMessages,
  parseSlackQaCredentialPayload,
  quiesceCodexApprovalAgentRun,
  resolveApprovalDecision,
  resolveCodexFileApprovalTargetPath,
  resolveSlackRateLimitDelayMs: adapterTesting.resolveSlackRateLimitDelayMs,
  resolveSlackQaRuntimeEnv,
  runSlackTableInvalidBlocksFallbackScenario,
  waitForSlackNoReply,
  waitForSlackReaction,
};

function renderExpectedSlackChartAccessibleText(summaryText: string) {
  return [
    summaryText,
    "",
    "QA latency trend (line chart)",
    "X axis: Percentile",
    "Y axis: Milliseconds",
    "- Latency: P50: 120; P95: 240",
  ].join("\n");
}

function renderExpectedSlackTableAccessibleText(summaryText: string) {
  return [
    summaryText,
    "",
    "QA pipeline report (table)",
    "Account\tStage\tARR",
    "Acme\tWon\t125000",
    "Globex\tReview\t82000",
  ].join("\n");
}

describe("Slack live QA runtime helpers", () => {
  it("converts Slack rate-limit retry seconds for the observer backoff", () => {
    expect(testing.resolveSlackRateLimitDelayMs({ retryAfter: 10 })).toBe(10_000);
    expect(testing.resolveSlackRateLimitDelayMs({ retryAfter: 0 })).toBeUndefined();
    expect(testing.resolveSlackRateLimitDelayMs(new Error("network failed"))).toBeUndefined();
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("resolves env credential payloads", () => {
    expect(
      testing.resolveSlackQaRuntimeEnv({
        OPENCLAW_QA_SLACK_CHANNEL_ID: "C123456789",
        OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "xoxb-driver",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "xoxb-sut",
        OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "xapp-sut",
      }),
    ).toEqual({
      channelId: "C123456789",
      driverBotToken: "xoxb-driver",
      sutBotToken: "xoxb-sut",
      sutAppToken: "xapp-sut",
    });
  });

  it("rejects malformed Slack channel ids", () => {
    expect(() =>
      testing.resolveSlackQaRuntimeEnv({
        OPENCLAW_QA_SLACK_CHANNEL_ID: "qa-channel",
        OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "xoxb-driver",
        OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "xoxb-sut",
        OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "xapp-sut",
      }),
    ).toThrow("OPENCLAW_QA_SLACK channelId must be a Slack id like C123 or U123.");
  });

  it("parses Convex credential payloads", () => {
    expect(
      testing.parseSlackQaCredentialPayload({
        channelId: "C123456789",
        driverBotToken: "xoxb-driver",
        sutBotToken: "xoxb-sut",
        sutAppToken: "xapp-sut",
      }),
    ).toEqual({
      channelId: "C123456789",
      driverBotToken: "xoxb-driver",
      sutBotToken: "xoxb-sut",
      sutAppToken: "xapp-sut",
    });
  });

  it("selects Slack scenarios by id", () => {
    expect(testing.findScenario(["slack-canary"]).map((scenario) => scenario.id)).toEqual([
      "slack-canary",
    ]);
  });

  it("selects the MPIM app-mention dedupe scenario", () => {
    expect(
      testing.findScenario(["slack-mpim-app-mention-dedupe"]).map((scenario) => scenario.id),
    ).toEqual(["slack-mpim-app-mention-dedupe"]);
  });

  it("enables group DMs and threaded replies for the MPIM app-mention scenario", () => {
    const scenario = testing.findScenario(["slack-mpim-app-mention-dedupe"])[0];
    if (!scenario) {
      throw new Error("missing Slack MPIM app-mention scenario");
    }
    const cfg = testing.buildSlackQaConfig(
      {},
      {
        channelId: "C123456789",
        driverBotUserId: "U999999999",
        overrides: scenario.configOverrides,
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    expect(cfg.channels?.slack?.accounts?.sut?.dm).toEqual({
      enabled: true,
      groupEnabled: true,
    });
    expect(cfg.channels?.slack?.accounts?.sut?.replyToMode).toBe("all");
  });

  it("surfaces MPIM cleanup failures and retains ownership for a retry", async () => {
    const run = testing.findScenario(["slack-mpim-app-mention-dedupe"])[0]?.buildRun("U_SUT");
    if (
      !run ||
      run.kind === "approval" ||
      run.kind === "codex-approval" ||
      run.kind === "direct-transport"
    ) {
      throw new Error("expected Slack MPIM message scenario");
    }
    const close = vi
      .fn()
      .mockRejectedValueOnce(new Error("close failed"))
      .mockRejectedValueOnce(new Error("close failed again"))
      .mockResolvedValueOnce({});
    const context = {
      channelId: "C_QA",
      driverClient: { auth: { test: vi.fn(async () => ({ user_id: "U_DRIVER" })) } },
      sutIdentity: { userId: "U_SUT" },
      sutReadClient: {
        conversations: {
          close,
          info: vi.fn(async () => {
            throw new Error("metadata unavailable");
          }),
          members: vi.fn(async () => ({ members: ["U_DRIVER", "U_SUT", "U_HUMAN"] })),
          open: vi.fn(async () => ({ channel: { id: "C_MPIM" } })),
        },
        users: { info: vi.fn(async () => ({ user: { id: "U_HUMAN" } })) },
      },
    } as never;

    await expect(run.beforeRun?.(context)).rejects.toThrow("metadata unavailable");
    await expect(run.cleanup?.(context)).rejects.toThrow("close failed again");
    await expect(run.cleanup?.(context)).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenNthCalledWith(1, { channel: "C_MPIM" });
    expect(close).toHaveBeenNthCalledWith(2, { channel: "C_MPIM" });
    expect(close).toHaveBeenNthCalledWith(3, { channel: "C_MPIM" });
  });

  it("keeps the MPIM recall turn in the native thread", async () => {
    const run = testing.findScenario(["slack-mpim-app-mention-dedupe"])[0]?.buildRun("U_SUT");
    if (
      !run ||
      run.kind === "approval" ||
      run.kind === "codex-approval" ||
      run.kind === "direct-transport" ||
      !run.afterReply
    ) {
      throw new Error("expected Slack MPIM message scenario with a recall turn");
    }
    const seedMarker = /SLACK_QA_MPIM_SEED_[A-Z0-9]+/u.exec(run.input)?.[0];
    if (!seedMarker) {
      throw new Error("missing Slack MPIM seed marker");
    }
    expect(run.input).toContain(
      `Reply with only a marker in this exact format: ${seedMarker}_BOT_<NONCE>.`,
    );
    expect(run.input).toContain("Replace <NONCE> with 8 to 32 new uppercase letters or digits.");
    const botReplyMarker = `${seedMarker}_BOT_TESTNONCE`;
    const recallMarker = seedMarker.replace("SEED", "RECALL");
    const expectedRecallMarker = `${recallMarker}_TESTNONCE`;
    const postMessage = vi.fn(async (_request: { text?: string }) => ({
      channel: "C_MPIM",
      ts: "2.000000",
    }));
    const history = vi.fn(async () => ({ messages: [] }));
    const replies = vi.fn(async () => ({
      messages: [
        {
          bot_id: "B_SUT",
          text: expectedRecallMarker,
          thread_ts: "1.000000",
          ts: "3.000000",
          user: "U_SUT",
        },
      ],
    }));

    await expect(
      run.afterReply(
        {
          text: botReplyMarker,
          thread_ts: "1.000000",
          ts: "1.500000",
          user: "U_SUT",
        },
        {
          channelId: "C_MPIM",
          driverClient: { chat: { postMessage } },
          sentTs: "1.000000",
          sutIdentity: { botId: "B_SUT", userId: "U_SUT" },
          sutReadClient: { conversations: { history, replies } },
        } as never,
      ),
    ).resolves.toContain("recovered the prior bot reply");

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C_MPIM",
        thread_ts: "1.000000",
      }),
    );
    const recallText = postMessage.mock.calls[0]?.[0]?.text;
    expect(recallText).toContain(`previous reply beginning with ${seedMarker}_BOT_`);
    expect(recallText).toContain(`exact format: ${recallMarker}_<NONCE>`);
    expect(recallText).not.toContain(botReplyMarker);
    expect(recallText).not.toContain("TESTNONCE");
  });

  it("rejects an MPIM seed reply without text before sending the recall turn", async () => {
    const run = testing.findScenario(["slack-mpim-app-mention-dedupe"])[0]?.buildRun("U_SUT");
    if (
      !run ||
      run.kind === "approval" ||
      run.kind === "codex-approval" ||
      run.kind === "direct-transport" ||
      !run.afterReply
    ) {
      throw new Error("expected Slack MPIM message scenario with a recall turn");
    }
    const postMessage = vi.fn();

    await expect(
      run.afterReply(
        {
          thread_ts: "1.000000",
          ts: "1.500000",
          user: "U_SUT",
        },
        {
          channelId: "C_MPIM",
          driverClient: { chat: { postMessage } },
          sentTs: "1.000000",
          sutIdentity: { botId: "B_SUT", userId: "U_SUT" },
          sutReadClient: { conversations: {} },
        } as never,
      ),
    ).rejects.toThrow("MPIM seed reply did not contain the provider-generated bot nonce");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("rejects an MPIM seed reply outside the native thread", async () => {
    const run = testing.findScenario(["slack-mpim-app-mention-dedupe"])[0]?.buildRun("U_SUT");
    if (
      !run ||
      run.kind === "approval" ||
      run.kind === "codex-approval" ||
      run.kind === "direct-transport" ||
      !run.afterReply
    ) {
      throw new Error("expected Slack MPIM message scenario with a recall turn");
    }
    const seedMarker = /SLACK_QA_MPIM_SEED_[A-Z0-9]+/u.exec(run.input)?.[0];
    if (!seedMarker) {
      throw new Error("missing Slack MPIM seed marker");
    }
    const postMessage = vi.fn();

    await expect(
      run.afterReply(
        {
          text: `${seedMarker}_BOT_TESTNONCE`,
          ts: "1.500000",
          user: "U_SUT",
        },
        {
          channelId: "C_MPIM",
          driverClient: { chat: { postMessage } },
          sentTs: "1.000000",
          sutIdentity: { botId: "B_SUT", userId: "U_SUT" },
          sutReadClient: { conversations: {} },
        } as never,
      ),
    ).rejects.toThrow("MPIM seed reply escaped the native Slack thread");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("selects native scenarios by explicit id", () => {
    const scenarioIds = [
      "slack-chart-presentation-native",
      "slack-table-presentation-native",
      "slack-table-invalid-blocks-fallback",
      "slack-progress-commentary-true",
      "slack-progress-commentary-false",
      "slack-progress-commentary-omitted",
      "slack-progress-commentary-verbose-dedupe",
      "slack-progress-commentary-verbose-full",
      "slack-reaction-glyph-native",
      "slack-approval-exec-native",
      "slack-approval-plugin-native",
      "slack-codex-approval-exec-native",
      "slack-codex-approval-plugin-native",
      "slack-channel-disabled-warning",
    ];
    const selectedIds = testing.findScenario(scenarioIds).map((scenario) => scenario.id);
    expect(new Set(selectedIds)).toEqual(new Set(scenarioIds));
    expect(
      requireFlowScenario(readQaScenarioById("slack-codex-approval-exec-native")).execution.runtime,
    ).toBe("codex");
    expect(
      requireFlowScenario(readQaScenarioById("slack-canary")).execution.runtime,
    ).toBeUndefined();
  });

  it("accepts only Codex harness providers for Codex approval scenarios", () => {
    expect(() =>
      testing.assertSlackCodexApprovalModelSupported("openai/gpt-5.6-luna"),
    ).not.toThrow();
    expect(() =>
      testing.assertSlackCodexApprovalModelSupported("codex/gpt-5.6-luna"),
    ).not.toThrow();
    expect(() =>
      testing.assertSlackCodexApprovalModelSupported("anthropic/claude-sonnet-4-6"),
    ).toThrow(
      'Slack Codex approval scenarios require an openai/* or codex/* model; received "anthropic/claude-sonnet-4-6".',
    );
  });

  it("enables Slack native exec and plugin approval delivery for approval scenarios", () => {
    const cfg = testing.buildSlackQaConfig(
      {},
      {
        channelId: "C123456789",
        driverBotUserId: "U999999999",
        overrides: {
          approvals: {
            exec: true,
            plugin: true,
            target: "channel",
          },
        },
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    expect(cfg.approvals?.exec).toEqual({ enabled: true, mode: "session" });
    expect(cfg.approvals?.plugin).toEqual({ enabled: true, mode: "session" });
    const account = cfg.channels?.slack?.accounts?.sut;
    expect(account?.allowFrom).toEqual(["U999999999"]);
    expect(account?.execApprovals).toEqual({
      enabled: true,
      approvers: ["U999999999"],
      target: "channel",
    });
    expect(account?.channels?.C123456789?.users).toEqual(["U999999999"]);
  });

  it("enables Codex guardian runtime and native plugin approval delivery for Codex approval scenarios", () => {
    const cfg = testing.buildSlackQaConfig(
      {
        agents: {
          defaults: {},
          list: [
            {
              id: "qa",
              model: { primary: "openai/gpt-5.6-luna" },
            },
          ],
        },
      },
      {
        channelId: "C123456789",
        driverBotUserId: "U999999999",
        overrides: {
          approvals: {
            exec: true,
            plugin: true,
            target: "channel",
          },
          codexApproval: true,
        },
        primaryModel: "openai/gpt-5.6-luna",
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    expect(cfg.plugins?.allow).toEqual(["slack", "codex"]);
    expect(cfg.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: {
        appServer: {
          mode: "guardian",
        },
      },
    });
    expect(cfg.tools?.exec?.mode).toBe("ask");
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.6-luna"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(cfg.approvals?.plugin).toEqual({ enabled: true, mode: "session" });
    expect(cfg.channels?.slack?.accounts?.sut?.execApprovals).toEqual({
      enabled: true,
      approvers: ["U999999999"],
      target: "channel",
    });
  });

  it("overrides both owner and channel allowlists for block scenarios", () => {
    const cfg = testing.buildSlackQaConfig(
      {},
      {
        channelId: "C123456789",
        driverBotUserId: "U999999999",
        overrides: {
          allowFrom: ["U_NEVER_ALLOWED"],
          channelEnabled: false,
          users: ["U_NEVER_ALLOWED"],
        },
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    const account = cfg.channels?.slack?.accounts?.sut;
    expect(account?.allowFrom).toEqual(["U_NEVER_ALLOWED"]);
    expect(account?.channels?.C123456789?.enabled).toBe(false);
    expect(account?.channels?.C123456789?.users).toEqual(["U_NEVER_ALLOWED"]);
  });

  it("configures and verifies the disabled-channel warning scenario", async () => {
    const scenario = testing.findScenario(["slack-channel-disabled-warning"])[0];
    expect(scenario?.configOverrides?.channelEnabled).toBe(false);

    const run = scenario?.buildRun("U999999999");
    const beforeRun = run && "beforeRun" in run ? run.beforeRun : undefined;
    const afterNoReply = run && "afterNoReply" in run ? run.afterNoReply : undefined;
    expect(beforeRun).toBeTypeOf("function");
    expect(afterNoReply).toBeTypeOf("function");
    const call = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 12 })
      .mockResolvedValueOnce({
        lines: ["Slack channel denied by configuration channel_not_allowed channel_disabled"],
      });
    await beforeRun?.({
      gateway: {
        call,
      },
    } as never);
    await expect(
      afterNoReply?.({
        gateway: {
          call,
        },
      } as never),
    ).resolves.toBe("structured disabled-channel warning observed");
    expect(call).toHaveBeenNthCalledWith(
      1,
      "logs.tail",
      { limit: 1, maxBytes: 32_000 },
      { timeoutMs: 20_000 },
    );
    expect(call).toHaveBeenCalledWith(
      "logs.tail",
      { cursor: 12, limit: 200, maxBytes: 256_000 },
      { timeoutMs: 20_000 },
    );
    await expect(
      afterNoReply?.({
        gateway: {
          call: vi.fn(async () => ({
            lines: [
              "Slack channel denied by configuration channel_not_allowed",
              "channel_disabled",
            ],
          })),
        },
      } as never),
    ).rejects.toThrow("did not emit the structured warning");
  });

  it("builds the Slack progress commentary true, false, omitted, and dedupe configs", () => {
    const buildScenarioConfig = (scenarioId: string) => {
      const scenario = testing.findScenario([scenarioId])[0];
      if (!scenario) {
        throw new Error(`missing Slack QA scenario: ${scenarioId}`);
      }
      return testing.buildSlackQaConfig(
        {
          agents: {
            defaults: { verboseDefault: "off" },
            list: [{ id: "qa", identity: { name: "C-3PO QA" } }],
          },
        },
        {
          channelId: "C123456789",
          driverBotUserId: "U999999999",
          overrides: scenario.configOverrides,
          sutAccountId: "sut",
          sutAppToken: "xapp-sut",
          sutBotToken: "xoxb-sut",
        },
      );
    };
    const progressConfig = (scenarioId: string) =>
      buildScenarioConfig(scenarioId).channels?.slack?.accounts?.sut?.streaming?.progress;

    expect(progressConfig("slack-progress-commentary-true")).toMatchObject({
      commentary: true,
      commandText: "raw",
      toolProgress: false,
    });
    expect(progressConfig("slack-progress-commentary-false")).toMatchObject({
      commentary: false,
      commandText: "raw",
      toolProgress: false,
    });
    expect(
      buildScenarioConfig("slack-progress-commentary-true").channels?.slack?.accounts?.sut
        ?.streaming?.nativeTransport,
    ).toBe(false);
    expect(
      buildScenarioConfig("slack-progress-commentary-false").agents?.defaults?.verboseDefault,
    ).toBe("off");
    expect(
      buildScenarioConfig("slack-mpim-app-mention-dedupe").channels?.slack?.accounts?.sut
        ?.streaming,
    ).toEqual({ mode: "off" });
    const omitted = progressConfig("slack-progress-commentary-omitted");
    expect(omitted).toMatchObject({ toolProgress: true });
    expect(Object.hasOwn(omitted ?? {}, "commentary")).toBe(false);
    expect(
      buildScenarioConfig("slack-progress-commentary-verbose-dedupe").agents?.defaults
        ?.verboseDefault,
    ).toBe("on");
    expect(
      buildScenarioConfig("slack-progress-commentary-verbose-full").agents?.defaults
        ?.verboseDefault,
    ).toBe("full");
    expect(buildScenarioConfig("slack-progress-commentary-true").agents?.list?.[0]?.identity).toBe(
      undefined,
    );
  });

  it("verifies progress commentary from history or successful captured message writes", () => {
    const cases = [
      {
        id: "slack-progress-commentary-true",
        commentaryTs: "1.500000",
        commentaryStyle: "lane",
        toolProgress: "absent",
      },
      {
        id: "slack-progress-commentary-false",
        commentaryTs: "1.500000",
        commentaryStyle: "headline",
        toolProgress: "absent",
      },
      {
        id: "slack-progress-commentary-omitted",
        commentaryTs: "1.500000",
        commentaryStyle: "headline",
        toolProgress: "absent",
      },
      {
        id: "slack-progress-commentary-verbose-dedupe",
        commentaryTs: "1.500000",
        commentaryStyle: "standalone",
        toolProgress: "standalone-redacted",
      },
      {
        id: "slack-progress-commentary-verbose-full",
        commentaryTs: "1.500000",
        commentaryStyle: "standalone",
        toolProgress: "standalone",
      },
    ] as const;

    for (const testCase of cases) {
      const scenario = testing.findScenario([testCase.id])[0];
      const run = scenario?.buildRun("U999999999");
      const input = run && "input" in run ? run.input : "";
      const commentaryMarker = input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
      const toolMarker = input.match(/SLACK-QA-TOOL-[0-9A-F]{8}/u)?.[0];
      const outputMarker = input.match(/SLACK-QA-OUTPUT-[0-9A-F]{8}/u)?.[0];
      const finalMarker = input.match(/SLACK-QA-COMMENTARY-DONE-[0-9A-F]{8}/u)?.[0];
      const verifyObserved = run && "verifyObserved" in run ? run.verifyObserved : undefined;
      if (!commentaryMarker || !toolMarker || !outputMarker || !finalMarker || !verifyObserved) {
        throw new Error(`missing Slack progress verifier: ${testCase.id}`);
      }
      // The command marker detects accidental tool detail disclosure in quiet drafts.
      expect(input).toContain(`sleep 5; printf '%s\\n' '${outputMarker}' # ${toolMarker}`);
      const messages = [
        {
          channelId: "C123456789",
          text: finalMarker,
          ts: "2.000000",
        },
        ...(testCase.commentaryTs
          ? [
              {
                channelId: "C123456789",
                text: testCase.commentaryStyle === "lane" ? "Working…" : commentaryMarker,
                ...(testCase.commentaryStyle === "lane"
                  ? { blockText: [`• *Commentary* — _${commentaryMarker}_`] }
                  : {}),
                ts: testCase.commentaryTs,
              },
            ]
          : []),
        ...(testCase.toolProgress === "absent"
          ? []
          : [
              {
                channelId: "C123456789",
                text:
                  testCase.toolProgress === "standalone-redacted"
                    ? "🛠️ Exec"
                    : `🛠️ Exec\n\`\`\`\n${outputMarker}\n\`\`\``,
                ts: "1.750000",
              },
            ]),
      ];
      expect(
        verifyObserved({
          finalMessage: { text: finalMarker, ts: "2.000000" },
          messages,
        }),
      ).toContain("verified");
    }
  });

  it("recognizes exact commentary rows within Slack progress cards", () => {
    const scenario = testing.findScenario(["slack-progress-commentary-true"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const commentaryMarker = input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
    const finalMarker = input.match(/SLACK-QA-COMMENTARY-DONE-[0-9A-F]{8}/u)?.[0];
    const verifyObserved = run && "verifyObserved" in run ? run.verifyObserved : undefined;
    if (!commentaryMarker || !finalMarker || !verifyObserved) {
      throw new Error("missing Slack progress commentary lane verifier");
    }
    const verifyCommentaryMessage = (message: { blockText?: string[]; text: string }) =>
      verifyObserved({
        finalMessage: { text: finalMarker, ts: "2.000000" },
        messages: [
          {
            channelId: "C123456789",
            ...message,
            ts: "1.500000",
          },
          {
            channelId: "C123456789",
            text: finalMarker,
            ts: "2.000000",
          },
        ],
      });

    for (const message of [
      { text: `_${commentaryMarker}_` },
      { text: ` \n_${commentaryMarker}_\t` },
      { text: `💬 ${commentaryMarker}` },
      { text: `:speech_balloon: ${commentaryMarker}` },
      { text: `_${commentaryMarker}_\n_more commentary_` },
      {
        blockText: [
          `✅ *Working*`,
          `• *Commentary* — _${commentaryMarker}_\n• *Commentary* — _another note_`,
        ],
        text: "Working…",
      },
      {
        blockText: [
          `• *Commentary* — _${commentaryMarker}_\n• *Commentary* — _${commentaryMarker}_`,
        ],
        text: "Working…",
      },
    ]) {
      expect(() => verifyCommentaryMessage(message)).not.toThrow();
    }
    for (const message of [
      { text: commentaryMarker },
      { text: `prefix _${commentaryMarker}_ suffix` },
      { text: `💬 ${commentaryMarker} extra prose` },
      { text: "Working…", blockText: [`• *Exec* — _${commentaryMarker}_`] },
      { text: "Working…", blockText: [`• *Commentary* — _${commentaryMarker} extra prose_`] },
      { text: "Working…", blockText: [`• *Update* — ${commentaryMarker}`] },
    ]) {
      expect(() => verifyCommentaryMessage(message)).toThrow(
        "expected commentary in the Slack progress commentary lane",
      );
    }
  });

  it("rejects commentary when false and mismatched tool progress", () => {
    const verify = (
      scenarioId: string,
      mutate: (markers: [string, string, string]) => string[],
      finalText: "echo" | "exact" = "exact",
    ) => {
      const scenario = testing.findScenario([scenarioId])[0];
      const run = scenario?.buildRun("U999999999");
      const input = run && "input" in run ? run.input : "";
      const markers = [
        input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0],
        input.match(/SLACK-QA-TOOL-[0-9A-F]{8}/u)?.[0],
        input.match(/SLACK-QA-COMMENTARY-DONE-[0-9A-F]{8}/u)?.[0],
      ];
      const verifyObserved = run && "verifyObserved" in run ? run.verifyObserved : undefined;
      if (markers.some((marker) => !marker) || !verifyObserved) {
        throw new Error(`missing Slack progress verifier: ${scenarioId}`);
      }
      // The some() guard above proves all three markers matched; tuple-narrow so
      // destructuring in mutate callbacks yields string under indexed-access checks.
      const completeMarkers = markers as [string, string, string];
      return () =>
        verifyObserved({
          finalMessage: {
            text:
              finalText === "exact"
                ? completeMarkers[2]
                : `${completeMarkers[0]} ${completeMarkers[2]}`,
            ts: "2.000000",
          },
          messages: mutate(completeMarkers).map((text) => ({
            channelId: "C123456789",
            text,
            ts: text.includes(completeMarkers[2]) ? "2.000000" : "1.500000",
          })),
        });
    };

    expect(
      verify("slack-progress-commentary-false", ([commentary, , final]) => [
        `💬 ${commentary}`,
        final,
      ]),
    ).toThrow("status headline");
    for (const toolPresentation of ["command", "output", "safe-summary"]) {
      expect(
        verify("slack-progress-commentary-true", ([commentary, tool, final]) => [
          `💬 ${commentary}`,
          toolPresentation === "command"
            ? tool
            : toolPresentation === "output"
              ? tool.replace("-TOOL-", "-OUTPUT-")
              : "🛠️ Exec",
          final,
        ]),
      ).toThrow("tool progress to stay out");
    }
    expect(
      verify("slack-progress-commentary-omitted", ([commentary, tool, final]) => [
        commentary,
        tool,
        final,
      ]),
    ).toThrow("tool progress to stay out");
    expect(
      verify(
        "slack-progress-commentary-true",
        ([commentary, , final]) => [`💬 ${commentary} ${final}`],
        "echo",
      ),
    ).toThrow("only the final marker");
  });

  it("rejects duplicate durable and draft commentary identities", () => {
    const scenario = testing.findScenario(["slack-progress-commentary-verbose-dedupe"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const marker = input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
    const finalMarker = input.match(/SLACK-QA-COMMENTARY-DONE-[0-9A-F]{8}/u)?.[0];
    const verifyObserved = run && "verifyObserved" in run ? run.verifyObserved : undefined;
    if (!marker || !finalMarker || !verifyObserved) {
      throw new Error("missing Slack progress dedupe verifier");
    }

    expect(() =>
      verifyObserved({
        finalMessage: { text: finalMarker, ts: "2.000000" },
        messages: [
          { channelId: "C123456789", text: `💬 ${marker}`, ts: "1.500000" },
          { channelId: "C123456789", text: `• ${marker}`, ts: "2.000000" },
        ],
      }),
    ).toThrow("exactly one Slack message identity containing commentary");
  });

  it.each(["🛠️ Exec", ":hammer_and_wrench: Exec"])(
    "accepts standalone commentary and the safe verbose tool summary %s",
    (toolText) => {
      const scenario = testing.findScenario(["slack-progress-commentary-verbose-dedupe"])[0];
      const run = scenario?.buildRun("U_SUT");
      if (
        !run ||
        run.kind === "approval" ||
        run.kind === "codex-approval" ||
        run.kind === "direct-transport" ||
        !run.verifyObserved
      ) {
        throw new Error("expected Slack commentary message scenario");
      }
      const commentaryMarker = run.input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
      const toolMarker = run.input.match(/SLACK-QA-TOOL-[0-9A-F]{8}/u)?.[0];
      const finalMarker = run.input.match(/SLACK-QA-COMMENTARY-DONE-[0-9A-F]{8}/u)?.[0];
      if (!commentaryMarker || !toolMarker || !finalMarker) {
        throw new Error("missing Slack progress markers");
      }

      expect(() =>
        run.verifyObserved?.({
          finalMessage: { text: finalMarker, ts: "3.000000" },
          messages: [
            { channelId: "C123456789", text: `💬 ${commentaryMarker}`, ts: "1.000000" },
            { channelId: "C123456789", text: toolText, ts: "2.000000" },
            { channelId: "C123456789", text: finalMarker, ts: "3.000000" },
          ],
        }),
      ).not.toThrow();
    },
  );

  it.each(
    [false, true].flatMap((finalEdit) =>
      ["TOOL", "OUTPUT"].map((markerKind) => ({ finalEdit, markerKind })),
    ),
  )(
    "rejects $markerKind disclosure in verbose-on progress (final edit: $finalEdit)",
    ({ finalEdit, markerKind }) => {
      const run = testing
        .findScenario(["slack-progress-commentary-verbose-dedupe"])[0]
        ?.buildRun("U_SUT");
      if (!run || !("input" in run) || !run.verifyObserved) {
        throw new Error("expected Slack progress message scenario");
      }
      const commentary = run.input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
      const tool = run.input.match(new RegExp(`SLACK-QA-${markerKind}-[0-9A-F]{8}`, "u"))?.[0];
      expect(() =>
        run.verifyObserved?.({
          finalMessage: { text: run.matchText, ts: "3" },
          messages: [
            { channelId: "C123456789", text: `💬 ${commentary}`, ts: "1" },
            {
              channelId: "C123456789",
              text: finalEdit ? `${tool} ${run.matchText}` : `🛠️ Exec ${tool}`,
              ts: finalEdit ? "3" : "2",
            },
            { channelId: "C123456789", text: run.matchText, ts: "3" },
          ],
        }),
      ).toThrow("command details and output must stay hidden in verbose-on progress");
    },
  );

  it("requires actual full tool output instead of echoed command metadata", () => {
    const run = testing
      .findScenario(["slack-progress-commentary-verbose-full"])[0]
      ?.buildRun("U_SUT");
    if (!run || !("input" in run) || !run.verifyObserved) {
      throw new Error("expected Slack progress message scenario");
    }
    const commentary = run.input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
    const output = run.input.match(/SLACK-QA-OUTPUT-[0-9A-F]{8}/u)?.[0];
    const command = run.input.match(/SLACK-QA-TOOL-[0-9A-F]{8}/u)?.[0];
    const verify = (toolMessages: Array<{ text: string; ts: string }>) =>
      run.verifyObserved?.({
        finalMessage: { text: run.matchText, ts: "final" },
        messages: [
          { channelId: "C123456789", text: `💬 ${commentary}`, ts: "commentary" },
          ...toolMessages.map((message) => ({ channelId: "C123456789", ...message })),
          { channelId: "C123456789", text: run.matchText, ts: "final" },
        ],
      });
    expect(() => verify([{ text: `🛠️ Exec: printf '${output}'`, ts: "tool" }])).toThrow(
      "expected exact tool output",
    );
    expect(() => verify([{ text: `🛠️ ${output}`, ts: "tool" }])).toThrow(
      "expected exact tool output",
    );
    // Slack's monitor transform removes compact command headers before delivery.
    const summary = `🛠️ \`sleep 5; printf '%s\\n' '${output}' # ${command}\``;
    const deliveredOutput = sanitizeAssistantVisibleText(
      `${summary}\n\`\`\`txt\n${output}\n\`\`\``,
    );
    expect(sanitizeAssistantVisibleText(summary)).toBe("");
    expect(deliveredOutput).toBe(`\`\`\`txt\n${output}\n\`\`\``);
    expect(() => verify([{ text: deliveredOutput, ts: "tool" }])).not.toThrow();
    expect(() => verify([{ text: output ?? "", ts: "tool" }])).not.toThrow();
    expect(() =>
      verify([{ text: `🛠️ Run command: # ${command}\n${output}`, ts: "tool" }]),
    ).not.toThrow();
    expect(() =>
      verify([
        { text: `🛠️ Exec\n${output}`, ts: "tool-1" },
        { text: `🛠️ Exec\n${output}`, ts: "tool-2" },
      ]),
    ).toThrow("expected exact tool output in one standalone verbose message");
    expect(() =>
      verify([
        { text: "🛠️ run sleep → print text", ts: "summary" },
        { text: `🛠️ run sleep → print text\n${output}`, ts: "output" },
      ]),
    ).not.toThrow();
    expect(() =>
      verify([
        { text: "🛠️ run sleep → print text", ts: "summary-1" },
        { text: "🛠️ run sleep → print text", ts: "summary-2" },
        { text: `🛠️ run sleep → print text\n${output}`, ts: "output" },
      ]),
    ).toThrow(
      "expected exact tool output in one standalone verbose message and at most one summary",
    );
    expect(() =>
      verify([
        { text: "🛠️ Exec", ts: "tool" },
        { text: `🛠️ Exec\n\`\`\`\n${output}\n\`\`\``, ts: "tool" },
      ]),
    ).not.toThrow();
  });

  it.each(["🛠️ run sleep → print text", "🛠️ Exec\nunmarked output"])(
    "rejects verbose-on metadata or output updates without protocol markers: %s",
    (text) => {
      const run = testing
        .findScenario(["slack-progress-commentary-verbose-dedupe"])[0]
        ?.buildRun("U_SUT");
      if (!run || !("input" in run) || !run.verifyObserved) {
        throw new Error("expected Slack progress message scenario");
      }
      const commentary = run.input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
      expect(() =>
        run.verifyObserved?.({
          finalMessage: { text: run.matchText, ts: "final" },
          messages: [
            { channelId: "C123456789", text: `💬 ${commentary}`, ts: "commentary" },
            { channelId: "C123456789", text: "🛠️ Exec", ts: "tool" },
            { channelId: "C123456789", text, ts: "tool" },
            { channelId: "C123456789", text: run.matchText, ts: "final" },
          ],
        }),
      ).toThrow("command details and output must stay hidden in verbose-on progress");
    },
  );

  it.each(["slack-progress-commentary-verbose-dedupe", "slack-progress-commentary-verbose-full"])(
    "rejects absent or merged standalone tool identities for %s",
    (scenarioId) => {
      const run = testing.findScenario([scenarioId])[0]?.buildRun("U_SUT");
      if (!run || !("input" in run) || !run.verifyObserved) {
        throw new Error("expected Slack progress message scenario");
      }
      const commentary = run.input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
      const output = run.input.match(/SLACK-QA-OUTPUT-[0-9A-F]{8}/u)?.[0];
      for (const toolTs of [undefined, "1", "3"]) {
        expect(() =>
          run.verifyObserved?.({
            finalMessage: { text: run.matchText, ts: "3" },
            messages: [
              { channelId: "C123456789", text: `💬 ${commentary}`, ts: "1" },
              ...(toolTs
                ? [
                    {
                      channelId: "C123456789",
                      text: scenarioId.endsWith("-full") ? `🛠️ Exec\n${output}` : "🛠️ Exec",
                      ts: toolTs,
                    },
                  ]
                : []),
              { channelId: "C123456789", text: run.matchText, ts: "3" },
            ],
          }),
        ).toThrow("standalone verbose message");
      }
    },
  );

  it("reports bounded presentation facts without raw Slack text or identities", () => {
    const run = testing.findScenario(["slack-progress-commentary-true"])[0]?.buildRun("U_SUT");
    if (!run || !("input" in run) || !run.verifyObserved) {
      throw new Error("expected Slack progress message scenario");
    }
    const commentary = run.input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
    const privateText = "private-observation-sentinel";
    const privateId = "private-message-identity";
    let failure = "";
    try {
      run.verifyObserved({
        finalMessage: { text: run.matchText, ts: "final" },
        messages: [
          ...Array.from({ length: 40 }, (_, index) => ({
            channelId: "C123456789",
            text: `:speech_balloon: ${commentary} ${privateText}\n${privateText}`,
            blockText: [`• *Commentary* — _${commentary}_`, privateText.repeat(1_000)],
            ts: `${privateId}-${index}`,
          })),
          { channelId: "C123456789", text: run.matchText, ts: "final" },
        ],
      });
    } catch (error) {
      failure = String(error);
    }
    expect(failure).toContain("expected exactly one Slack message identity containing commentary");
    expect(failure).toContain("presentation=");
    expect(failure).toContain('"text":"emoji/other"');
    expect(JSON.parse(failure.split("presentation=")[1] ?? "[]")).toHaveLength(16);
    expect(failure).not.toContain(privateText);
    expect(failure).not.toContain(privateId);
    expect(failure).not.toContain(commentary);
    expect(failure.length).toBeLessThan(4_000);
  });

  it("distinguishes marker envelopes and missing command comments without retaining text", () => {
    const run = testing.findScenario(["slack-progress-commentary-true"])[0]?.buildRun("U_SUT");
    if (!run || !("input" in run) || !run.verifyObserved) {
      throw new Error("expected Slack progress message scenario");
    }
    const commentary = run.input.match(/SLACK-QA-COMMENTARY-[0-9A-F]{8}/u)?.[0];
    const presentations = [
      ["", "", "none/none"],
      ["**", "**", "bold/bold"],
      ["_", "_", "italic/italic"],
      ["\\_", "\\_", "escaped-italic/escaped-italic"],
      ["`", "`", "code/code"],
      ["> ", "", "quote/none"],
      ["• ", "", "bullet/none"],
      [":speech_balloon: ", "", "emoji/none"],
    ];
    let failure = "";
    try {
      run.verifyObserved({
        finalMessage: { text: "invalid final", ts: "final" },
        messages: [
          ...presentations.map(([prefix, suffix]) => ({
            channelId: "C123456789",
            text: `${prefix}${commentary}${suffix}`,
            blockText: [`• *Commentary* — _${commentary}_\n_${commentary}_`],
            ts: "same-private-identity",
          })),
          ...Array.from({ length: 40 }, () => ({
            channelId: "C123456789",
            text: "🛠️ `sleep 5`",
            ts: "tool-private-identity",
          })),
        ],
      });
    } catch (error) {
      failure = String(error);
    }
    const facts = JSON.parse(failure.split("presentation=")[1] ?? "[]");
    expect(facts).toHaveLength(presentations.length + 1);
    expect(facts.map((fact: { text: string }) => fact.text)).toEqual([
      ...presentations.map((presentation) => presentation[2]),
      "missing",
    ]);
    expect(facts[0]).toMatchObject({
      block: "commentary-row/italic",
      lines: [1, 2],
      occurrences: [1, 2],
    });
    expect(facts.at(-1)).toMatchObject({ tool: "sleep-without-marker" });
    expect(failure).not.toContain(commentary);
    expect(failure).not.toContain("private-identity");
    expect(failure).not.toContain("sleep 5");
    expect(failure.length).toBeLessThan(4_000);
  });

  it("settles complete channel and thread observations after the final reply", async () => {
    let historyCalls = 0;
    const observedMessages: Array<{ text: string }> = [];
    await testing.observeSlackScenarioMessages({
      channelId: "C123456789",
      client: {
        conversations: {
          history: async () => {
            historyCalls += 1;
            return {
              messages:
                historyCalls === 1
                  ? [
                      { text: "FINAL_MARKER", ts: "3.000000", user: "U999999999" },
                      { text: "EARLIER_COMMENTARY", ts: "2.000000", user: "U999999999" },
                    ]
                  : [
                      { text: "LATE_DUPLICATE", ts: "4.000000", user: "U999999999" },
                      { text: "FINAL_MARKER", ts: "3.000000", user: "U999999999" },
                    ],
            };
          },
          replies: async () => ({
            messages: [{ text: "THREAD_DUPLICATE", ts: "5.000000", user: "U999999999" }],
          }),
        },
      } as never,
      matchText: "FINAL_MARKER",
      observedMessages: observedMessages as never,
      observationScenarioId: "slack-progress-commentary-verbose-dedupe",
      observationScenarioTitle: "Slack commentary dedupe",
      sentTs: "1.000000",
      settleMs: 10,
      sutIdentity: { userId: "U999999999" },
      threadTs: "1.000000",
    });

    expect(historyCalls).toBeGreaterThanOrEqual(2);
    expect(new Set(observedMessages.map((message) => message.text))).toEqual(
      new Set(["FINAL_MARKER", "EARLIER_COMMENTARY", "LATE_DUPLICATE", "THREAD_DUPLICATE"]),
    );
  });

  it("extracts typed Slack approval button values from blocks", () => {
    const actionValue =
      'openclaw:approval:v1:{"approvalId":"plugin:abc","approvalKind":"plugin","decision":"allow-once"}';
    expect(
      testing.collectSlackActionValues([
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Allow Once" },
              value: actionValue,
            },
          ],
        },
      ]),
    ).toEqual([actionValue]);
  });

  it("extracts plugin approval ids from typed Slack approval action values", () => {
    expect(
      testing.extractSlackNativeApprovalId({
        actionValues: [
          'openclaw:approval:v1:{"approvalId":"plugin:abc123","approvalKind":"plugin","decision":"allow-once"}',
          'openclaw:approval:v1:{"approvalId":"plugin:abc123","approvalKind":"plugin","decision":"deny"}',
        ],
        decision: "allow-once",
      }),
    ).toBe("plugin:abc123");
  });

  it("resolves the Codex file approval target path", () => {
    expect(testing.resolveCodexFileApprovalTargetPath("MARKER")).toMatch(
      /\.openclaw-qa-codex-file-approval-marker\.txt$/u,
    );
  });

  it("instructs the live reaction scenario to preserve the exact emoji glyph", () => {
    const scenario = testing.findScenario(["slack-reaction-glyph-native"])[0];
    const run = scenario?.buildRun("U999999999");

    expect(run).toMatchObject({ expectReply: true });
    expect(run && "input" in run ? run.input : "").toContain('emoji to exactly "✅"');
    expect(run && "input" in run ? run.input : "").toContain("Do not substitute a shortcode");
  });

  it("drives the live native chart scenario through a portable message-tool presentation", () => {
    const scenario = testing.findScenario(["slack-chart-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_CHART_SUMMARY_[A-Z0-9]+/u)?.[0];

    expect(run).toMatchObject({ expectReply: true });
    expect(scenario?.configOverrides).toEqual({ messageTool: true });
    if (!summaryText) {
      throw new Error("missing Slack chart summary token");
    }
    expect(input).toContain(
      JSON.stringify({
        action: "send",
        message: summaryText,
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "line",
              title: "QA latency trend",
              categories: ["P50", "P95"],
              series: [{ name: "Latency", values: [120, 240] }],
              xLabel: "Percentile",
              yLabel: "Milliseconds",
            },
          ],
        },
      }),
    );
    expect(run && "matchText" in run ? run.matchText : "").toMatch(
      /^SLACK_QA_CHART_DONE_[A-Z0-9]+$/u,
    );
  });

  it("verifies the SUT-owned native chart and exact accessible top-level text", async () => {
    const scenario = testing.findScenario(["slack-chart-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_CHART_SUMMARY_[A-Z0-9]+/u)?.[0];
    const afterReply = run && "afterReply" in run ? run.afterReply : undefined;
    if (!summaryText || !afterReply) {
      throw new Error("missing Slack chart scenario verifier");
    }
    const accessibleText = renderExpectedSlackChartAccessibleText(summaryText);
    const history = vi.fn(async () => ({
      messages: [
        {
          blocks: [
            {
              type: "data_visualization",
              title: "QA latency trend",
              chart: {
                type: "line",
                series: [
                  {
                    name: "Latency",
                    data: [
                      { label: "P50", value: 120 },
                      { label: "P95", value: 240 },
                    ],
                  },
                ],
                axis_config: {
                  categories: ["P50", "P95"],
                  x_label: "Percentile",
                  y_label: "Milliseconds",
                },
              },
            },
          ],
          // Slack history flattens the top-level accessibility newlines on readback.
          text: accessibleText.replace(/\s+/gu, " "),
          ts: "2.000000",
          user: "U999999999",
        },
      ],
    }));

    await expect(
      afterReply(
        {} as never,
        {
          channelId: "C123456789",
          sentTs: "1.000000",
          sutIdentity: { userId: "U999999999" },
          sutReadClient: { conversations: { history } },
        } as never,
      ),
    ).resolves.toBe("verified native data_visualization block and deterministic accessible text");
    expect(history).toHaveBeenCalledWith({
      channel: "C123456789",
      inclusive: true,
      limit: 50,
      oldest: "1.000000",
    });
  });

  it("rejects fallback-only Slack chart delivery", async () => {
    vi.useFakeTimers();
    const scenario = testing.findScenario(["slack-chart-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_CHART_SUMMARY_[A-Z0-9]+/u)?.[0];
    const afterReply = run && "afterReply" in run ? run.afterReply : undefined;
    if (!summaryText || !afterReply) {
      throw new Error("missing Slack chart scenario verifier");
    }
    const accessibleText = renderExpectedSlackChartAccessibleText(summaryText);
    const history = vi.fn(async () => ({
      messages: [
        {
          text: accessibleText.replace(/\s+/gu, " "),
          ts: "2.000000",
          user: "U999999999",
        },
      ],
    }));
    const result = expect(
      afterReply(
        {} as never,
        {
          channelId: "C123456789",
          sentTs: "1.000000",
          sutIdentity: { userId: "U999999999" },
          sutReadClient: { conversations: { history } },
        } as never,
      ),
    ).rejects.toThrow("waiting for Slack message");

    await vi.advanceTimersByTimeAsync(16_000);
    await result;
  });

  it("drives the live native table scenario through a portable message-tool presentation", () => {
    const scenario = testing.findScenario(["slack-table-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_TABLE_SUMMARY_[A-Z0-9]+/u)?.[0];

    expect(run).toMatchObject({ expectReply: true });
    expect(scenario?.configOverrides).toEqual({ messageTool: true });
    if (!summaryText) {
      throw new Error("missing Slack table summary token");
    }
    expect(input).toContain(
      JSON.stringify({
        action: "send",
        message: summaryText,
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "QA pipeline report",
              headers: ["Account", "Stage", "ARR"],
              rows: [
                ["Acme", "Won", 125000],
                ["Globex", "Review", 82000],
              ],
              rowHeaderColumnIndex: 0,
            },
          ],
        },
      }),
    );
    expect(run && "matchText" in run ? run.matchText : "").toBe(summaryText);
  });

  it("verifies the SUT-owned native table and exact accessible top-level text", async () => {
    const scenario = testing.findScenario(["slack-table-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_TABLE_SUMMARY_[A-Z0-9]+/u)?.[0];
    const afterReply = run && "afterReply" in run ? run.afterReply : undefined;
    if (!summaryText || !afterReply) {
      throw new Error("missing Slack table scenario verifier");
    }
    const accessibleText = renderExpectedSlackTableAccessibleText(summaryText);
    const history = vi.fn(async () => ({
      messages: [
        {
          blocks: [
            {
              type: "data_table",
              caption: "QA pipeline report",
              rows: [
                [
                  { type: "raw_text", text: "Account" },
                  { type: "raw_text", text: "Stage" },
                  { type: "raw_text", text: "ARR" },
                ],
                [
                  { type: "raw_text", text: "Acme" },
                  { type: "raw_text", text: "Won" },
                  { type: "raw_number", value: 125000, text: "125000" },
                ],
                [
                  { type: "raw_text", text: "Globex" },
                  { type: "raw_text", text: "Review" },
                  { type: "raw_number", value: 82000, text: "82000" },
                ],
              ],
              row_header_column_index: 0,
            },
          ],
          text: accessibleText.replace(/\s+/gu, " "),
          ts: "2.000000",
          user: "U999999999",
        },
      ],
    }));

    await expect(
      afterReply(
        {} as never,
        {
          channelId: "C123456789",
          sentTs: "1.000000",
          sutIdentity: { userId: "U999999999" },
          sutReadClient: { conversations: { history } },
        } as never,
      ),
    ).resolves.toBe("verified native data_table block and deterministic accessible text");
  });

  it("rejects fallback-only Slack table delivery", async () => {
    vi.useFakeTimers();
    const scenario = testing.findScenario(["slack-table-presentation-native"])[0];
    const run = scenario?.buildRun("U999999999");
    const input = run && "input" in run ? run.input : "";
    const summaryText = input.match(/SLACK_QA_TABLE_SUMMARY_[A-Z0-9]+/u)?.[0];
    const afterReply = run && "afterReply" in run ? run.afterReply : undefined;
    if (!summaryText || !afterReply) {
      throw new Error("missing Slack table scenario verifier");
    }
    const history = vi.fn(async () => ({
      messages: [
        {
          text: renderExpectedSlackTableAccessibleText(summaryText).replace(/\s+/gu, " "),
          ts: "2.000000",
          user: "U999999999",
        },
      ],
    }));
    const result = expect(
      afterReply(
        {} as never,
        {
          channelId: "C123456789",
          sentTs: "1.000000",
          sutIdentity: { userId: "U999999999" },
          sutReadClient: { conversations: { history } },
        } as never,
      ),
    ).rejects.toThrow("waiting for Slack message");

    await vi.advanceTimersByTimeAsync(16_000);
    await result;
  });

  it("builds the invalid_blocks fallback probe as a direct transport scenario", () => {
    const scenario = testing.findScenario(["slack-table-invalid-blocks-fallback"])[0];
    const run = scenario?.buildRun("U999999999");
    const probe = testing.buildSlackInvalidBlocksTableProbe();

    expect(run).toMatchObject({ kind: "direct-transport" });
    expect(probe.dataRowCount).toBe(101);
    expect(probe.block).toMatchObject({
      type: "data_table",
      caption: "QA invalid_blocks fallback",
      row_header_column_index: 0,
    });
    expect(probe.block.rows).toHaveLength(102);
    expect(probe.block.rows[0]).toEqual([
      { type: "raw_text", text: "Row" },
      { type: "raw_text", text: "Value" },
    ]);
    expect(probe.cellCharacterCount).toBeGreaterThan(10_000);
    expect(probe.firstRowText).toMatch(/^row-001\tvalue-001-x{96}$/u);
    expect(probe.finalRowText).toMatch(/^row-101\tvalue-101-x{96}$/u);
    expect(probe.fallbackText.split("\n")).toContain(probe.firstRowText);
    expect(probe.fallbackText.split("\n")).toContain(probe.finalRowText);
  });

  it("proves the public Slack send path stores complete ordered fallback chunks", async () => {
    const probe = testing.buildSlackInvalidBlocksTableProbe();
    const storedPayloads: Array<Record<string, unknown> & { ts: string }> = [];
    const postMessage = vi.fn(async (payload: Record<string, unknown>) => {
      const ts = `2.${String(storedPayloads.length + 1).padStart(6, "0")}`;
      storedPayloads.push({ ...payload, ts });
      return { channel: "C123456789", ok: true, ts };
    });
    const history = vi.fn(async () => ({
      messages: storedPayloads.toReversed().map((payload) => ({
        blocks: payload.blocks,
        text: typeof payload.text === "string" ? payload.text.replace(/\s+/gu, " ") : payload.text,
        ts: payload.ts,
        user: "U999999999",
      })),
    }));
    const sutWriteClient = { chat: { postMessage } };
    const cfg = testing.buildSlackQaConfig(
      {},
      {
        channelId: "C123456789",
        driverBotUserId: "U111111111",
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    const result = await testing.runSlackTableInvalidBlocksFallbackScenario({
      cfg,
      channelId: "C123456789",
      sutAccountId: "sut",
      sutIdentity: { userId: "U999999999" },
      sutReadClient: { conversations: { history } } as never,
      sutWriteClient: sutWriteClient as never,
      timeoutMs: 0,
    });

    expect(postMessage).toHaveBeenCalledTimes(3);
    const fallbackRequests = postMessage.mock.calls.map(([request]) => request);
    expect(fallbackRequests.every((request) => !Object.hasOwn(request, "blocks"))).toBe(true);
    expect(fallbackRequests.every((request) => request.mrkdwn === false)).toBe(true);
    const fallbackText = fallbackRequests.map((request) => request.text).join("");
    expect(fallbackText).toHaveLength(probe.fallbackText.length);
    expect(fallbackText.split("\n")).toContain(probe.firstRowText);
    expect(fallbackText.split("\n")).toContain(probe.finalRowText);
    expect(storedPayloads.map((payload) => payload.ts)).toEqual([
      "2.000001",
      "2.000002",
      "2.000003",
    ]);
    expect(
      storedPayloads
        .map((payload) =>
          typeof payload.text === "string" ? payload.text.replace(/\s+/gu, " ") : "",
        )
        .join(""),
    ).toBe(fallbackText.replace(/\s+/gu, " "));
    expect(result.message).toMatchObject({ ts: "2.000003", user: "U999999999" });
    expect(result.details).toContain("first API failure=invalid_blocks");
    expect(result.details).toContain("API attempts=4");
    expect(result.details).toContain("fallback formatting disabled=true");
    expect(result.details).toContain("fallback chunks=3");
    expect(result.details).toContain("first row=present");
    expect(result.details).toContain("final row=present");
    expect(result.details).toContain("complete delivery=true");
    expect(sutWriteClient.chat.postMessage).toBe(postMessage);
  });

  it("bounds invalid_blocks readback diagnostics while showing the observed text", async () => {
    const malformedReadback = `BROKEN-${"x".repeat(2_000)}`;
    let postCount = 0;
    const postMessage = vi.fn(async () => {
      postCount += 1;
      return {
        channel: "C123456789",
        ok: true,
        ts: `2.${String(postCount).padStart(6, "0")}`,
      };
    });
    const sutWriteClient = { chat: { postMessage } };
    const cfg = testing.buildSlackQaConfig(
      {},
      {
        channelId: "C123456789",
        driverBotUserId: "U111111111",
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    const error = await testing
      .runSlackTableInvalidBlocksFallbackScenario({
        cfg,
        channelId: "C123456789",
        sutAccountId: "sut",
        sutIdentity: { userId: "U999999999" },
        sutReadClient: {
          conversations: {
            history: vi.fn(async () => ({
              messages: [
                { text: "", ts: "2.000003", user: "U999999999" },
                { text: "", ts: "2.000002", user: "U999999999" },
                { text: malformedReadback, ts: "2.000001", user: "U999999999" },
              ],
            })),
          },
        } as never,
        sutWriteClient: sutWriteClient as never,
        timeoutMs: 0,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`${malformedReadback.length} characters`);
    expect(message).toContain('actual="BROKEN-');
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(700);
  });

  it("reports the real Slack error when the fallback request fails", async () => {
    const postMessage = vi.fn(async () => {
      throw Object.assign(new Error("do not persist this raw platform detail"), {
        data: { error: "invalid_arguments", ok: false },
      });
    });
    const sutWriteClient = { chat: { postMessage } };
    const cfg = testing.buildSlackQaConfig(
      {},
      {
        channelId: "C123456789",
        driverBotUserId: "U111111111",
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    await expect(
      testing.runSlackTableInvalidBlocksFallbackScenario({
        cfg,
        channelId: "C123456789",
        sutAccountId: "sut",
        sutIdentity: { userId: "U999999999" },
        sutReadClient: { conversations: { history: vi.fn() } } as never,
        sutWriteClient: sutWriteClient as never,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(
      "Slack fallback part 1 failed after invalid_blocks; observed invalid_arguments",
    );
    expect(sutWriteClient.chat.postMessage).toBe(postMessage);
  });

  it("does not expose an untrusted Slack fallback error value", async () => {
    const postMessage = vi.fn(async () => {
      throw Object.assign(new Error("private platform detail"), {
        data: { error: "unsafe private detail", ok: false },
      });
    });
    const sutWriteClient = { chat: { postMessage } };
    const cfg = testing.buildSlackQaConfig(
      {},
      {
        channelId: "C123456789",
        driverBotUserId: "U111111111",
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    await expect(
      testing.runSlackTableInvalidBlocksFallbackScenario({
        cfg,
        channelId: "C123456789",
        sutAccountId: "sut",
        sutIdentity: { userId: "U999999999" },
        sutReadClient: { conversations: { history: vi.fn() } } as never,
        sutWriteClient: sutWriteClient as never,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(
      "Slack fallback part 1 failed after invalid_blocks; observed no fallback API failure code",
    );
    expect(sutWriteClient.chat.postMessage).toBe(postMessage);
  });

  it("reports a later Slack fallback chunk failure", async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ channel: "C123456789", ok: true, ts: "2.000001" })
      .mockRejectedValueOnce(
        Object.assign(new Error("do not persist this raw platform detail"), {
          data: { error: "invalid_arguments", ok: false },
        }),
      );
    const sutWriteClient = { chat: { postMessage } };
    const cfg = testing.buildSlackQaConfig(
      {},
      {
        channelId: "C123456789",
        driverBotUserId: "U111111111",
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    await expect(
      testing.runSlackTableInvalidBlocksFallbackScenario({
        cfg,
        channelId: "C123456789",
        sutAccountId: "sut",
        sutIdentity: { userId: "U999999999" },
        sutReadClient: { conversations: { history: vi.fn() } } as never,
        sutWriteClient: sutWriteClient as never,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(
      "Slack fallback part 2 failed after invalid_blocks; observed invalid_arguments",
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(sutWriteClient.chat.postMessage).toBe(postMessage);
  });

  it("enables the message tool for the live reaction scenario", () => {
    const scenario = testing.findScenario(["slack-reaction-glyph-native"])[0];
    const cfg = testing.buildSlackQaConfig(
      {},
      {
        channelId: "C123456789",
        driverBotUserId: "U999999999",
        overrides: scenario?.configOverrides,
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    expect(cfg.tools?.alsoAllow).toContain("message");
  });

  it("adds the message tool to an explicit allowlist without mixing tool policies", () => {
    const scenario = testing.findScenario(["slack-reaction-glyph-native"])[0];
    const cfg = testing.buildSlackQaConfig(
      { tools: { allow: ["read"] } },
      {
        channelId: "C123456789",
        driverBotUserId: "U999999999",
        overrides: scenario?.configOverrides,
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    expect(cfg.tools?.allow).toEqual(["read", "message"]);
    expect(cfg.tools?.alsoAllow).toBeUndefined();
  });

  it("preserves an empty allowlist as allow-all when enabling the message tool", () => {
    const scenario = testing.findScenario(["slack-reaction-glyph-native"])[0];
    const cfg = testing.buildSlackQaConfig(
      { tools: { allow: [] } },
      {
        channelId: "C123456789",
        driverBotUserId: "U999999999",
        overrides: scenario?.configOverrides,
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    expect(cfg.tools?.allow).toEqual([]);
    expect(cfg.tools?.alsoAllow).toEqual(["message"]);
  });

  it("requires the SUT-owned normalized Slack reaction", async () => {
    const get = vi.fn(async () => ({
      message: {
        reactions: [{ count: 1, name: "white_check_mark", users: ["U999999999"] }],
      },
    }));

    await expect(
      testing.waitForSlackReaction({
        channelId: "C123456789",
        client: { reactions: { get } } as never,
        expectedReactionName: "white_check_mark",
        messageId: "123.456",
        sutUserId: "U999999999",
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({ name: "white_check_mark" });
    expect(get).toHaveBeenCalledWith({
      channel: "C123456789",
      full: true,
      timestamp: "123.456",
    });
  });

  it("aborts, awaits terminal cleanup, and stops the gateway process tree before cleanup", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ aborted: true, runIds: ["run-123"] })
      .mockResolvedValueOnce({ endedAt: 123, runId: "run-123", status: "ok" });
    const stopGateway = vi.fn();

    await testing.quiesceCodexApprovalAgentRun({
      context: { gateway: { call } } as never,
      preserveDebugArtifacts: false,
      runId: "run-123",
      sessionKey: "agent:qa:approval",
      stopGateway,
    });

    expect(call).toHaveBeenNthCalledWith(
      1,
      "chat.abort",
      { runId: "run-123", sessionKey: "agent:qa:approval" },
      { timeoutMs: 10_000 },
    );
    expect(call).toHaveBeenNthCalledWith(
      2,
      "agent.wait",
      { runId: "run-123", timeoutMs: 10_000 },
      { timeoutMs: 15_000 },
    );
    expect(stopGateway).toHaveBeenCalledWith(false);
  });

  it("preserves debug artifacts when abort and terminal acknowledgements fail", async () => {
    const call = vi.fn().mockRejectedValue(new Error("gateway unavailable"));
    const stopGateway = vi.fn();

    await testing.quiesceCodexApprovalAgentRun({
      context: { gateway: { call } } as never,
      preserveDebugArtifacts: true,
      runId: "run-123",
      sessionKey: "agent:qa:approval",
      stopGateway,
    });

    expect(stopGateway).toHaveBeenCalledWith(true);
  });

  it("builds approval checkpoint message evidence from Slack blocks", () => {
    expect(
      testing.buildSlackApprovalCheckpointMessage({
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Plugin approval required" },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Allow Once" },
                value:
                  'openclaw:approval:v1:{"approvalId":"plugin:abc","approvalKind":"plugin","decision":"allow-once"}',
              },
            ],
          },
        ],
        text: "Plugin approval required",
      }),
    ).toEqual({
      actionLabels: ["Allow Once"],
      blockText: ["Plugin approval required", "Allow Once"],
      hasNativeActions: true,
      text: "Plugin approval required",
    });
  });

  it("allows live approval resolve RPCs to take longer than the generic gateway probe timeout", async () => {
    const call = vi.fn(async () => ({ decision: "allow-once" }));

    await testing.resolveApprovalDecision({
      approvalId: "plugin:abc",
      context: {
        gateway: { call },
      } as never,
      decision: "allow-once",
      kind: "plugin",
    });

    expect(call).toHaveBeenCalledWith(
      "plugin.approval.resolve",
      { decision: "allow-once", id: "plugin:abc" },
      {
        expectFinal: false,
        timeoutMs: 35_000,
      },
    );
  });

  it("ignores delayed unrelated SUT replies during mention-gating", async () => {
    const observedMessages: Array<unknown> = [];
    await expect(
      testing.waitForSlackNoReply({
        channelId: "C123456789",
        client: {
          conversations: {
            history: async () => ({
              messages: [
                {
                  text: "I should not have replied",
                  ts: "2.000000",
                  user: "U999999999",
                },
              ],
            }),
          },
        } as never,
        matchText: "SLACK_QA_NOMENTION_MARKER",
        observedMessages: observedMessages as never,
        observationScenarioId: "slack-mention-gating",
        observationScenarioTitle: "Slack unmentioned bot message does not trigger",
        sentTs: "1.000000",
        sutIdentity: { userId: "U999999999" },
        timeoutMs: 10,
      }),
    ).resolves.toBeUndefined();
    const typedObservedMessages = observedMessages as Array<{
      matchedScenario?: boolean;
      text?: string;
      ts?: string;
      userId?: string;
    }>;
    expect(typedObservedMessages).toHaveLength(1);
    expect(typedObservedMessages[0]?.matchedScenario).toBe(false);
    expect(typedObservedMessages[0]?.text).toBe("I should not have replied");
    expect(typedObservedMessages[0]?.ts).toBe("2.000000");
    expect(typedObservedMessages[0]?.userId).toBe("U999999999");
  });

  it("fails mention-gating when the SUT replies with the marker", async () => {
    await expect(
      testing.waitForSlackNoReply({
        channelId: "C123456789",
        client: {
          conversations: {
            history: async () => ({
              messages: [
                {
                  text: "SLACK_QA_NOMENTION_MARKER",
                  ts: "2.000000",
                  user: "U999999999",
                },
              ],
            }),
          },
        } as never,
        matchText: "SLACK_QA_NOMENTION_MARKER",
        observedMessages: [],
        observationScenarioId: "slack-mention-gating",
        observationScenarioTitle: "Slack unmentioned bot message does not trigger",
        sentTs: "1.000000",
        sutIdentity: { userId: "U999999999" },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("unexpected Slack SUT reply observed");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
