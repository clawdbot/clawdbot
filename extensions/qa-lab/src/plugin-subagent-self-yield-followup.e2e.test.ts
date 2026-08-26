import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { startQaGatewayChild } from "./gateway-child.js";
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

    const gateway = await startQaGatewayChild({
      repoRoot: REPO_ROOT,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transport,
      transportBaseUrl: bus.baseUrl,
      controlUiEnabled: false,
      mutateConfig: withFixturePlugin,
    });
    cleanups.push(() => gateway.stop());
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

    try {
      const spawn = await transport.waitForOutbound({
        conversation: REQUESTER_CONVERSATION,
        sinceIndex: outboundStartIndex,
        textIncludes: "QA-SELF-YIELD-SPAWNED",
        timeoutMs: 30_000,
      });

      // Anchor the quiet window on the spawn acknowledgement itself rather than a
      // snapshot taken afterwards, so an announce arriving between the two is
      // still observed instead of being skipped as already-seen traffic.
      const outboundAfterSpawn =
        state
          .getSnapshot()
          .messages.filter((message) => message.direction === "outbound")
          .findIndex((message) => message.id === spawn.id) + 1;
      // The child pauses itself here. The requester must stay parked: an announce
      // now would report a run that has produced no result yet, which is the
      // silent-wrong-outcome this flow exists to prevent.
      await transport.waitForNoOutbound({
        sinceIndex: outboundAfterSpawn,
        quietMs: 15_000,
      });

      const [, kickoffRunId, childSessionKey] = spawn.text.split(" ");
      expect(childSessionKey).toBeTruthy();

      const followUpResponse = await fetch(`${gateway.baseUrl}/qa/self-yield/follow-up`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gateway.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey: childSessionKey }),
      });
      expect(followUpResponse.status).toBe(200);
      const followUp = (await followUpResponse.json()) as { runId: string };
      // Adoption retires the paused run in favour of the follow-up, so the two
      // runs are distinct gateway ids over one continued unit of work.
      expect(followUp.runId).not.toBe(kickoffRunId);

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
  }, 180_000);
});
