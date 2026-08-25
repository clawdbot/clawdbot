import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildWhatsAppQaConfig } from "./whatsapp-live.config.js";
import type { WhatsAppQaMessageScenarioContext } from "./whatsapp-live.contracts.js";
import { whatsappQaPollVoteHookProofScenario } from "./whatsapp-live.scenario-implementations.poll-vote-proof.js";

function buildContext(params: {
  artifactDir: string;
  gatewayCall: ReturnType<typeof vi.fn>;
  pollMessageId: string;
}) {
  const pollVote = {
    fromJid: "15550000002@s.whatsapp.net",
    fromPhoneE164: null,
    kind: "poll_vote" as const,
    messageId: "vote-update-1",
    observedAt: new Date().toISOString(),
    pollVote: {
      pollMessageId: params.pollMessageId,
      chatJid: "15550000001@s.whatsapp.net",
      voter: "15550000002@s.whatsapp.net",
      selectedOptions: ["alpha"],
    },
    text: "",
  };
  const driver = {
    close: vi.fn(async () => undefined),
    getObservedMessages: vi.fn(() => [pollVote]),
    sendContact: vi.fn(),
    sendLocation: vi.fn(),
    sendMedia: vi.fn(),
    sendPoll: vi.fn(),
    sendReaction: vi.fn(),
    sendSticker: vi.fn(),
    sendText: vi.fn(),
    waitForMessage: vi.fn(async () => pollVote),
  };
  const context = {
    driver,
    driverPhoneE164: "+15550000001",
    gateway: {
      call: params.gatewayCall,
      logs: () => 'poll vote received for +15550000002@s.whatsapp.net; "token":"secret-value"',
      workspaceDir: params.artifactDir,
    },
    gatewayTarget: "+15550000002",
    gatewayWorkspaceDir: params.artifactDir,
    proofOutputDir: params.artifactDir,
    recordObservedMessage: vi.fn(),
    requestStartedAt: new Date(),
    repoRoot: process.cwd(),
    scenarioId: "whatsapp-poll-vote-hook-proof",
    scenarioTitle: "WhatsApp poll-vote hook proof",
    sent: { messageId: "trigger-message-1" },
    sutAccountId: "sut",
    sutPhoneE164: "+15550000002",
    target: "+15550000002",
    targetKind: "dm" as const,
    waitForReady: vi.fn(async () => undefined),
  } satisfies WhatsAppQaMessageScenarioContext;
  return { context, pollVote };
}

describe("WhatsApp poll-vote hook proof scenario", () => {
  it("enables the channel hook and loads the isolated fixture", () => {
    const cfg = buildWhatsAppQaConfig(
      {},
      {
        allowFrom: ["+15550000001"],
        authDir: "/tmp/qa-sut",
        dmPolicy: "allowlist",
        ownerAllowFrom: ["+15550000001"],
        proofOutputDir: "/tmp/qa-proof",
        overrides: {
          pollVoteHookProof: {
            fixturePath: "/repo/extensions/qa-lab/test-fixtures/whatsapp-poll-vote-proof-plugin",
          },
        },
        sutAccountId: "sut",
      },
    );

    expect(cfg.channels?.whatsapp?.pluginHooks?.pollVoteReceived).toBe(true);
    expect(cfg.plugins?.allow).toContain("qa-whatsapp-poll-vote-proof");
    expect(cfg.plugins?.load?.paths).toContain(
      "/repo/extensions/qa-lab/test-fixtures/whatsapp-poll-vote-proof-plugin",
    );
    expect(cfg.plugins?.entries?.["qa-whatsapp-poll-vote-proof"]).toMatchObject({
      enabled: true,
      config: { outputPath: path.join("/tmp/qa-proof", "hook-events.jsonl") },
    });
  });

  it("uses Gateway poll send, waits for a driver vote, and writes redacted proof artifacts", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-poll-proof-"));
    try {
      const pollMessageId = "gateway-poll-1";
      const proofDir = path.join(artifactDir, "whatsapp-poll-vote-hook-proof");
      const gatewayCall = vi.fn(async (method: string) => {
        expect(method).toBe("poll");
        await mkdir(proofDir, { recursive: true });
        await writeFile(
          path.join(proofDir, "hook-events.jsonl"),
          [
            {
              event: "poll_vote_received",
              pollMessageId: "not-the-poll",
              selectedOptions: ["alpha"],
              context: { messageId: "hook-message-1" },
            },
            {
              event: "poll_vote_received",
              pollMessageId: "d7f4861efe8dcafb",
              selectedOptions: ["alpha"],
              context: { messageId: "hook-message-2" },
            },
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
        );
        return { messageId: pollMessageId };
      });
      const { context } = buildContext({ artifactDir, gatewayCall, pollMessageId });
      const run = whatsappQaPollVoteHookProofScenario.buildRun();
      const details = await run.afterReply?.({} as never, context);

      expect(gatewayCall).toHaveBeenCalledWith(
        "poll",
        expect.objectContaining({
          options: ["alpha", "beta"],
          maxSelections: 1,
        }),
        expect.anything(),
      );
      expect(context.driver.waitForMessage).toHaveBeenCalledOnce();
      expect(details).toContain("whatsapp-poll-vote-hook-proof");
      const proof = JSON.parse(await readFile(path.join(proofDir, "proof.json"), "utf8")) as {
        assertions: Record<string, boolean>;
        status: string;
      };
      expect(proof.status).toBe("pass");
      expect(proof.assertions).toEqual({
        isolatedQaGateway: true,
        pollVoteReceivedEnabled: true,
        gatewayPollSendAccepted: true,
        driverPollVoteObserved: true,
        hookFixtureOutputObserved: true,
      });
      expect(await readFile(path.join(proofDir, "transcript.txt"), "utf8")).not.toContain(
        "+15550000002",
      );
      expect(await readFile(path.join(proofDir, "gateway-log.txt"), "utf8")).not.toContain(
        "secret-value",
      );
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });

  it("rejects a Gateway poll response without the accepted message identifier", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-poll-proof-"));
    try {
      const { context } = buildContext({
        artifactDir,
        gatewayCall: vi.fn(async () => ({})),
        pollMessageId: "gateway-poll-1",
      });
      const run = whatsappQaPollVoteHookProofScenario.buildRun();

      await expect(run.afterReply?.({} as never, context)).rejects.toThrow(
        "Gateway poll proof requires an accepted poll messageId",
      );
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
  });
});
