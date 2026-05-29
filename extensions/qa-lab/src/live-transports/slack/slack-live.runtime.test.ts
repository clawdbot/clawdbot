import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testing, runSlackQaLive } from "./slack-live.runtime.js";

describe("Slack live QA runtime helpers", () => {
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

  it("reports standard live transport scenario coverage", () => {
    expect(testing.SLACK_QA_STANDARD_SCENARIO_IDS).toEqual([
      "canary",
      "mention-gating",
      "allowlist-block",
      "top-level-reply-shape",
      "restart-resume",
      "thread-follow-up",
      "thread-isolation",
    ]);
  });

  it("selects Slack scenarios by id", () => {
    expect(testing.findScenario(["slack-canary"]).map((scenario) => scenario.id)).toEqual([
      "slack-canary",
    ]);
  });

  it("selects native approval scenarios by id without changing standard coverage", () => {
    expect(
      testing
        .findScenario(["slack-approval-exec-native", "slack-approval-plugin-native"])
        .map((scenario) => scenario.id),
    ).toEqual(["slack-approval-exec-native", "slack-approval-plugin-native"]);
    expect(testing.SLACK_QA_STANDARD_SCENARIO_IDS).not.toContain("slack-approval-exec-native");
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
      channelId: undefined,
      decision: "allow-once",
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
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      channelId: string;
      credentials: { kind: string; role?: string; source: string };
    };
    expect(summary.channelId).toBe("<unavailable>");
    expect(summary.credentials).toEqual({
      kind: "slack",
      role: "ci",
      source: "convex",
    });
  });
});
