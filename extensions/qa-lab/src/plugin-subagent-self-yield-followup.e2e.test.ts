import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { QA_SUBAGENT_SELF_YIELD_MARKER } from "./providers/mock-openai/mock-openai-contracts.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const PLUGIN_ID = "qa-self-yield-followup-subagent";
const TRIGGER = "qa self yield follow-up";
const REQUESTER_CONVERSATION = { id: "requester-user", kind: "direct" as const };
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = path.join(
  REPO_ROOT,
  "extensions/qa-lab/test-fixtures/self-yield-followup-subagent-plugin",
);
const VERDICT_PATH = path.join(
  REPO_ROOT,
  ".artifacts/qa-e2e/handoff-adoption/channel-handoff-verdict.json",
);

function withFixturePlugin(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), PLUGIN_DIR])],
      },
      entries: {
        ...config.plugins?.entries,
        [PLUGIN_ID]: { enabled: true },
      },
    },
  };
}

describe("plugin subagent sessions_yield follow-up", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it("announces to the original requester only after the follow-up run ends", async () => {
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const bus = await startQaBusServer({ state });
    cleanups.push(() => bus.stop());

    const mock = await startQaMockOpenAiServer();
    cleanups.push(() => mock.stop());

    const gatewayOwner = createQaGatewayChild();
    cleanups.push(async () => {
      expect((await gatewayOwner.stop()).errors).toEqual([]);
    });
    const gateway = await gatewayOwner.start({
      repoRoot: REPO_ROOT,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: withFixturePlugin,
    });
    await transport.waitReady({ gateway });

    const outboundStartIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await transport.sendInbound({
      accountId: "default",
      conversation: REQUESTER_CONVERSATION,
      senderId: REQUESTER_CONVERSATION.id,
      text: TRIGGER,
    });

    const failureContext = (error: unknown) =>
      new Error(
        [
          error instanceof Error ? error.message : String(error),
          `bus=${JSON.stringify(state.getSnapshot())}`,
          `gateway=${gateway.logs()}`,
        ].join("\n"),
        { cause: error },
      );
    let distinctFollowupRun: boolean;

    try {
      const followUpResponse = await fetch(`${gateway.baseUrl}/qa/self-yield/follow-up`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gateway.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(followUpResponse.status).toBe(202);
      const followUp = (await followUpResponse.json()) as {
        kickoffRunId?: string;
        runId: string;
      };
      expect(followUp.runId).toBeTruthy();
      const releaseResponse = await fetch(`${gateway.baseUrl}/qa/self-yield/release`, {
        method: "POST",
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      expect(releaseResponse.status).toBe(200);
      const release = (await releaseResponse.json()) as {
        finalReply?: string;
        kickoffRunId?: string;
        runId?: string;
        status?: string;
      };
      expect(release).toMatchObject({
        finalReply: QA_SUBAGENT_SELF_YIELD_MARKER,
        status: "ok",
      });
      expect(release.kickoffRunId).toBeTruthy();
      expect(release.runId).toBe(followUp.runId);
      expect(release.runId).not.toBe(release.kickoffRunId);
      distinctFollowupRun = release.runId !== release.kickoffRunId;

      const completion = await transport.waitForOutbound({
        conversation: REQUESTER_CONVERSATION,
        sinceIndex: outboundStartIndex,
        textIncludes: QA_SUBAGENT_SELF_YIELD_MARKER,
        timeoutMs: 90_000,
      });
      expect(completion.accountId).toBe("default");
    } catch (error) {
      throw failureContext(error);
    }

    const outbound = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound");
    // Exactly one announce for the whole continued run: the paused kickoff must
    // not announce separately, and the follow-up must not announce twice.
    expect(
      outbound.filter((message) => message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER)),
    ).toHaveLength(1);
    const visibleRepliesBeforeQuiet = outbound.filter((message) =>
      message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER),
    ).length;
    await transport.waitForNoOutbound({
      sinceIndex: outbound.length,
      quietMs: 1_000,
    });
    const visibleRepliesAfterQuiet = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" && message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER),
      ).length;
    await gateway.restartAfterStateMutation(async () => {});
    await transport.waitReady({ gateway });
    await transport.waitForNoOutbound({
      sinceIndex: outbound.length,
      quietMs: 1_000,
    });
    const visibleRepliesAfterRestart = state
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" && message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER),
      ).length;
    const requests = (await fetch(`${mock.baseUrl}/debug/requests`).then((response) =>
      response.json(),
    )) as Array<{ plannedToolName?: string; prompt?: string }>;
    const handoffRequests = requests.filter(
      (request) =>
        request.prompt?.includes("Subagent self yield qa worker") ||
        request.prompt?.includes("Subagent self yield qa remote job finished"),
    );
    expect(requests).toHaveLength(2);
    const verdict = {
      schemaVersion: 1,
      scenario: "channel-handoff-adoption",
      status: "pass",
      channel: "qa-channel",
      provider: "mock-openai",
      gateway: "ephemeral",
      facts: {
        sessionsYieldCalls: requests.filter(
          (request) => request.plannedToolName === "sessions_yield",
        ).length,
        childModelRequests: handoffRequests.length,
        visibleReplies: outbound.filter((message) =>
          message.text.includes(QA_SUBAGENT_SELF_YIELD_MARKER),
        ).length,
        duplicateRepliesAfterQuietWindow: visibleRepliesAfterQuiet - visibleRepliesBeforeQuiet,
        duplicateRepliesAfterGatewayRestart: visibleRepliesAfterRestart - visibleRepliesAfterQuiet,
        distinctFollowupRun,
      },
    };
    expect(verdict.facts).toEqual({
      sessionsYieldCalls: 1,
      childModelRequests: 2,
      visibleReplies: 1,
      duplicateRepliesAfterQuietWindow: 0,
      duplicateRepliesAfterGatewayRestart: 0,
      distinctFollowupRun: true,
    });
    await mkdir(path.dirname(VERDICT_PATH), { recursive: true });
    await writeFile(VERDICT_PATH, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  }, 180_000);
});
