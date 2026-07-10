// Qa Lab tests cover slack live plugin behavior.
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QA_EVIDENCE_FILENAME, QA_EVIDENCE_SUMMARY_KIND } from "../../evidence-summary.js";
import { testing, runSlackQaLive } from "./slack-live.runtime.js";

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

describe("Slack live QA runtime helpers", () => {
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

  it("canonicalizes the SUT account before config and approval routing", () => {
    expect(testing.resolveSlackQaSutAccountId(" QA-SUT ")).toBe("qa-sut");
    expect(testing.resolveSlackQaSutAccountId()).toBe("sut");
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

  it("reports live transport standard scenario coverage", () => {
    expect(testing.SLACK_QA_STANDARD_SCENARIO_IDS).toEqual([
      "canary",
      "mention-gating",
      "allowlist-block",
      "top-level-reply-shape",
    ]);
  });

  it("selects Slack scenarios by id", () => {
    expect(testing.findScenario(["slack-canary"]).map((scenario) => scenario.id)).toEqual([
      "slack-canary",
    ]);
  });

  it("selects opt-in native scenarios by id without changing standard scenario coverage", () => {
    expect(
      testing
        .findScenario([
          "slack-chart-presentation-native",
          "slack-reaction-glyph-native",
          "slack-approval-exec-native",
          "slack-approval-plugin-native",
          "slack-codex-approval-exec-native",
          "slack-codex-approval-plugin-native",
        ])
        .map((scenario) => scenario.id),
    ).toEqual([
      "slack-chart-presentation-native",
      "slack-reaction-glyph-native",
      "slack-approval-exec-native",
      "slack-approval-plugin-native",
      "slack-codex-approval-exec-native",
      "slack-codex-approval-plugin-native",
    ]);
    expect(testing.SLACK_QA_STANDARD_SCENARIO_IDS).not.toContain("slack-approval-exec-native");
    expect(testing.SLACK_QA_STANDARD_SCENARIO_IDS).not.toContain("slack-chart-presentation-native");
    expect(testing.SLACK_QA_STANDARD_SCENARIO_IDS).not.toContain("slack-reaction-glyph-native");
    expect(testing.SLACK_QA_STANDARD_SCENARIO_IDS).not.toContain(
      "slack-codex-approval-exec-native",
    );
  });

  it("accepts only Codex harness providers for Codex approval scenarios", () => {
    expect(() => testing.assertSlackCodexApprovalModelSupported("openai/gpt-5.5")).not.toThrow();
    expect(() => testing.assertSlackCodexApprovalModelSupported("codex/gpt-5.5")).not.toThrow();
    expect(() =>
      testing.assertSlackCodexApprovalModelSupported("anthropic/claude-sonnet-4-6"),
    ).toThrow(
      'Slack Codex approval scenarios require an openai/* or codex/* model; received "anthropic/claude-sonnet-4-6".',
    );
  });

  it("rejects an incompatible Codex approval model before credential acquisition", async () => {
    const outputDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-slack-codex-model-"));
    await expect(
      runSlackQaLive({
        credentialSource: "convex",
        outputDir,
        primaryModel: "anthropic/claude-sonnet-4-6",
        scenarioIds: ["slack-codex-approval-exec-native"],
      }),
    ).rejects.toThrow(
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
              model: { primary: "openai/gpt-5.5" },
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
        primaryModel: "openai/gpt-5.5",
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
    expect(cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
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
          users: ["U_NEVER_ALLOWED"],
        },
        sutAccountId: "sut",
        sutAppToken: "xapp-sut",
        sutBotToken: "xoxb-sut",
      },
    );

    const account = cfg.channels?.slack?.accounts?.sut;
    expect(account?.allowFrom).toEqual(["U_NEVER_ALLOWED"]);
    expect(account?.channels?.C123456789?.users).toEqual(["U_NEVER_ALLOWED"]);
  });

  it("extracts Slack native approval button values from blocks", () => {
    expect(
      testing.collectSlackActionValues([
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Allow Once" },
              value: "/approve plugin:abc allow-once",
            },
          ],
        },
      ]),
    ).toEqual(["/approve plugin:abc allow-once"]);
  });

  it("extracts plugin approval ids from native Slack approval action values", () => {
    expect(
      testing.extractSlackNativeApprovalId({
        actionValues: ["/approve plugin:abc123 allow-once", "/approve plugin:abc123 deny"],
        decision: "allow-once",
      }),
    ).toBe("plugin:abc123");
  });

  it("builds Codex approval instructions for command and file-change routes", () => {
    expect(
      testing.buildCodexApprovalInstruction({
        appServerMethod: "item/commandExecution/requestApproval",
        token: "SLACK_QA_CODEX_EXEC_APPROVAL_ABC123",
      }),
    ).toContain("Use the shell tool exactly once");
    expect(
      testing.buildCodexApprovalInstruction({
        appServerMethod: "item/fileChange/requestApproval",
        token: "SLACK_QA_CODEX_FILE_APPROVAL_ABC123",
      }),
    ).toContain("Do not ask for approval in chat");
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

  it("reads the accepted asynchronous Gateway agent run id", () => {
    expect(
      testing.readAcceptedAgentRunId({
        runId: "run-123",
        status: "accepted",
      }),
    ).toBe("run-123");
    expect(() =>
      testing.readAcceptedAgentRunId({
        runId: "run-123",
        status: "started",
      }),
    ).toThrow("instead of accepted");
  });

  it("requires the Codex command transcript to prove the approved operation", () => {
    const run = {
      approvalKind: "plugin" as const,
      appServerMethod: "item/commandExecution/requestApproval" as const,
      decision: "allow-once" as const,
      kind: "codex-approval" as const,
      token: "SLACK_QA_CODEX_EXEC_APPROVAL_ABC123",
    };
    expect(() =>
      testing.assertCodexApprovalTranscriptSucceeded(
        [
          {
            role: "toolResult",
            isError: false,
            content: [
              {
                type: "toolResult",
                content: "SLACK_QA_CODEX_EXEC_APPROVAL_ABC123",
              },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "SLACK_QA_CODEX_EXEC_APPROVAL_ABC123" }],
          },
        ],
        run,
      ),
    ).not.toThrow();
    expect(() =>
      testing.assertCodexApprovalTranscriptSucceeded(
        [
          {
            role: "assistant",
            content: [{ type: "text", text: "SLACK_QA_CODEX_EXEC_APPROVAL_ABC123" }],
          },
        ],
        run,
      ),
    ).toThrow("Codex command result did not contain marker");
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

  it("matches pending Codex plugin approvals by id, route, and Slack turn source", () => {
    expect(
      testing.findPendingCodexPluginApprovalRecord({
        approvalId: "plugin:abc123",
        appServerMethod: "item/fileChange/requestApproval",
        channelId: "C123456789",
        records: [
          {
            id: "plugin:abc123",
            request: {
              pluginId: "openclaw-codex-app-server",
              title: "Codex app-server file approval",
              toolName: "codex_file_approval",
              sessionKey: "agent:qa:slack-codex-approval-plugin-native-token",
              turnSourceChannel: "slack",
              turnSourceTo: "channel:C123456789",
              turnSourceAccountId: "sut",
            },
          },
        ],
        sessionKey: "agent:qa:slack-codex-approval-plugin-native-token",
        sutAccountId: "sut",
      }),
    ).toBeDefined();
    expect(
      testing.findPendingCodexPluginApprovalRecord({
        approvalId: "plugin:abc123",
        appServerMethod: "item/commandExecution/requestApproval",
        channelId: "C123456789",
        records: [
          {
            id: "plugin:abc123",
            request: {
              pluginId: "openclaw-codex-app-server",
              title: "Codex app-server file approval",
              toolName: "codex_file_approval",
              sessionKey: "agent:qa:slack-codex-approval-plugin-native-token",
              turnSourceChannel: "slack",
              turnSourceTo: "channel:C123456789",
              turnSourceAccountId: "sut",
            },
          },
        ],
        sessionKey: "agent:qa:slack-codex-approval-plugin-native-token",
        sutAccountId: "sut",
      }),
    ).toBeUndefined();
  });

  it("matches resolved Codex approvals without pending-only marker text", () => {
    expect(
      testing.matchesSlackApprovalResolvedUpdate({
        actionValues: [],
        approvalKind: "plugin",
        decision: "allow-once",
        extraTextMatches: ["openclaw-codex-app-server", "Codex app-server file approval"],
        text: [
          "Plugin approval: Allowed once",
          "Codex app-server file approval",
          "Plugin: openclaw-codex-app-server",
        ].join("\n"),
      }),
    ).toBe(true);
    expect(
      testing.matchesSlackApprovalResolvedUpdate({
        actionValues: ["/approve plugin:abc allow-once"],
        approvalKind: "plugin",
        decision: "allow-once",
        extraTextMatches: ["Codex app-server file approval"],
        text: "Plugin approval: Allowed once\nCodex app-server file approval",
      }),
    ).toBe(false);
  });

  it("matches pending Codex approvals by stable renderer fields without marker text", () => {
    expect(
      testing.matchesSlackApprovalPromptText({
        approvalKind: "plugin",
        extraTextMatches: ["openclaw-codex-app-server", "Codex app-server command approval"],
        text: [
          "Plugin approval required",
          "Codex app-server command approval",
          "Plugin: openclaw-codex-app-server",
        ].join("\n"),
      }),
    ).toBe(true);
    expect(
      testing.matchesSlackApprovalPromptText({
        approvalKind: "plugin",
        extraTextMatches: ["Codex app-server file approval"],
        text: "Plugin approval required\nCodex app-server command approval",
      }),
    ).toBe(false);
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
                value: "/approve plugin:abc allow-once",
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

  it("resolves Slack approval checkpoint configuration from env", () => {
    expect(
      testing.resolveSlackApprovalCheckpointConfig({
        OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR: "/tmp/checkpoints",
        OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_TIMEOUT_MS: "5000",
      }),
    ).toEqual({
      checkpointDir: "/tmp/checkpoints",
      timeoutMs: 5000,
    });
    expect(testing.resolveSlackApprovalCheckpointConfig({})).toBeUndefined();
  });

  it("uses started Slack channel readiness for native approval-only scenarios", () => {
    const startedStatus = {
      lastError: null,
      restartPending: false,
      running: true,
    };

    expect(testing.isSlackChannelReadyForQa(startedStatus, "started")).toBe(true);
    expect(testing.isSlackChannelReadyForQa(startedStatus, "connected")).toBe(false);
    expect(
      testing.isSlackChannelReadyForQa(
        {
          ...startedStatus,
          connected: false,
        },
        "started",
      ),
    ).toBe(false);
    expect(
      testing.isSlackChannelReadyForQa(
        {
          ...startedStatus,
          lastError: "socket auth failed",
        },
        "started",
      ),
    ).toBe(false);
  });

  it("keeps Slack readiness stability anchored when connectedAt is absent", () => {
    expect(
      testing.resolveSlackChannelReadySince({
        observedAt: 2_000,
        previousReadySince: undefined,
        status: {
          lastError: null,
          restartPending: false,
          running: true,
        },
      }),
    ).toBe(2_000);
    expect(
      testing.resolveSlackChannelReadySince({
        observedAt: 3_000,
        previousReadySince: 2_000,
        status: {
          lastError: null,
          restartPending: false,
          running: true,
        },
      }),
    ).toBe(2_000);
    expect(
      testing.resolveSlackChannelReadySince({
        observedAt: 4_000,
        previousReadySince: 2_000,
        status: {
          lastConnectedAt: 3_500,
          lastError: null,
          restartPending: false,
          running: true,
        },
      }),
    ).toBe(3_500);
  });

  it("resolves Slack readiness timeout from the shared transport env", () => {
    expect(testing.resolveSlackQaReadyTimeoutMs({})).toBe(45_000);
    expect(
      testing.resolveSlackQaReadyTimeoutMs({
        OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: "180000",
      }),
    ).toBe(180_000);
    expect(
      testing.resolveSlackQaReadyTimeoutMs({
        OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS: "bad",
      }),
    ).toBe(45_000);
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

  it("preserves sanitized gateway debug artifacts on scenario failure", async () => {
    const cleanupIssues: string[] = [];
    const stop = vi.fn(async () => {});

    await testing.preserveSlackGatewayDebugArtifacts({
      cleanupIssues,
      gatewayDebugDirPath: ".artifacts/qa-e2e/slack-live-test/gateway-debug",
      gatewayHarness: { stop } as never,
    });

    expect(stop).toHaveBeenCalledWith({
      preserveToDir: ".artifacts/qa-e2e/slack-live-test/gateway-debug",
    });
    expect(cleanupIssues).toEqual([]);
  });

  it("redacts approval artifact content and Slack metadata in summary-shaped results", () => {
    expect(
      testing.toSlackQaScenarioArtifactResults({
        includeContent: false,
        redactMetadata: true,
        scenarios: [
          {
            approval: {
              approvalId: "plugin:abc",
              approvalKind: "plugin",
              channelId: "C123456789",
              decision: "allow-once",
              pendingActionValues: ["/approve plugin:abc allow-once"],
              pendingMessageTs: "1.000000",
              pendingText: "Plugin approval required",
              resolvedActionValues: [],
              resolvedMessageTs: "1.000000",
              resolvedText: "Plugin approval: Allowed once",
              threadTs: "1.000000",
            },
            details: "plugin approval resolved",
            id: "slack-approval-plugin-native",
            status: "pass",
            title: "Slack native plugin approval prompt resolves with exec approvals enabled",
          },
        ],
      })[0]?.approval,
    ).toEqual({
      approvalId: "<redacted>",
      approvalKind: "plugin",
      appServerMethod: undefined,
      channelId: undefined,
      codexModelKey: undefined,
      decision: "allow-once",
      finalCodexTurnStatus: undefined,
      operationVerified: undefined,
      pendingActionValues: undefined,
      pendingCheckpointPath: undefined,
      pendingMessageTs: undefined,
      pendingScreenshotPath: undefined,
      pendingText: undefined,
      resolvedActionValues: undefined,
      resolvedCheckpointPath: undefined,
      resolvedMessageTs: undefined,
      resolvedScreenshotPath: undefined,
      resolvedText: undefined,
      threadTs: undefined,
    });
  });

  it("keeps Codex approval route metadata while redacting Slack metadata", () => {
    expect(
      testing.toSlackQaScenarioArtifactResults({
        includeContent: false,
        redactMetadata: true,
        scenarios: [
          {
            approval: {
              approvalId: "plugin:abc",
              approvalKind: "plugin",
              appServerMethod: "item/fileChange/requestApproval",
              channelId: "C123456789",
              codexModelKey: "openai/gpt-5.5",
              decision: "allow-once",
              finalCodexTurnStatus: "ok",
              operationVerified: true,
              pendingActionValues: ["/approve plugin:abc allow-once"],
              pendingMessageTs: "1.000000",
              pendingText: "Plugin approval required",
              resolvedActionValues: [],
              resolvedMessageTs: "1.000000",
              resolvedText: "Plugin approval: Allowed once",
              threadTs: "1.000000",
            },
            details: "codex plugin approval resolved",
            id: "slack-codex-approval-plugin-native",
            status: "pass",
            title: "Slack native Codex file approval prompt resolves",
          },
        ],
      })[0]?.approval,
    ).toMatchObject({
      approvalId: "<redacted>",
      appServerMethod: "item/fileChange/requestApproval",
      channelId: undefined,
      codexModelKey: "openai/gpt-5.5",
      finalCodexTurnStatus: "ok",
      operationVerified: true,
      pendingActionValues: undefined,
      pendingMessageTs: undefined,
      pendingText: undefined,
      resolvedActionValues: undefined,
      resolvedMessageTs: undefined,
      resolvedText: undefined,
      threadTs: undefined,
    });
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

  it("writes artifacts when Convex credential acquisition fails", async () => {
    const outputDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-slack-qa-"));
    const result = await runSlackQaLive({
      credentialRole: "ci",
      credentialSource: "convex",
      outputDir,
    });

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0]?.id).toBe("slack-canary");
    expect(result.scenarios[0]?.status).toBe("fail");
    expect(result.scenarios[0]?.details).toContain("Missing OPENCLAW_QA_CONVEX_SITE_URL");
    await expect(fs.stat(result.reportPath).then((stats) => stats.isFile())).resolves.toBe(true);
    expect(path.basename(result.summaryPath)).toBe(QA_EVIDENCE_FILENAME);
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      entries: Array<{
        result: { failure?: { reason?: string }; status: string };
        test: { id: string };
      }>;
      kind: string;
    };
    expect(summary.kind).toBe(QA_EVIDENCE_SUMMARY_KIND);
    expect(summary.entries[0]).toMatchObject({
      test: {
        id: "slack-canary",
      },
      result: {
        status: "fail",
        failure: {
          reason: expect.stringContaining("Missing OPENCLAW_QA_CONVEX_SITE_URL"),
        },
      },
    });
  });
});
