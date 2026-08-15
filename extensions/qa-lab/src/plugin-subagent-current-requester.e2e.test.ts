import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { startQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const PLUGIN_ID = "qa-current-requester-subagent";
const TRIGGER = "qa current requester completion";
const COMPLETION_MARKER = "QA-CURRENT-REQUESTER-COMPLETION-OK";
const REQUESTER_CONVERSATION = { id: "requester-user", kind: "direct" as const };
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = path.join(
  REPO_ROOT,
  "extensions/qa-lab/test-fixtures/current-requester-subagent-plugin",
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

describe("plugin subagent current-requester delivery", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it("delivers to the captured requester and rejects forged lineage outside hook scope", async () => {
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

    const outsideHookResponse = await fetch(
      `${gateway.baseUrl}/qa/current-requester/outside-hook`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${gateway.token}` },
      },
    );
    expect(outsideHookResponse.status).toBe(409);
    await expect(outsideHookResponse.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("requester-bound plugin hook invocation"),
    });

    const outboundStartIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await transport.sendInbound({
      accountId: "default",
      conversation: REQUESTER_CONVERSATION,
      senderId: REQUESTER_CONVERSATION.id,
      text: TRIGGER,
    });

    let completion;
    try {
      const spawn = await transport.waitForOutbound({
        conversation: REQUESTER_CONVERSATION,
        sinceIndex: outboundStartIndex,
        timeoutMs: 30_000,
      });
      expect(spawn.text).toContain("QA-CURRENT-REQUESTER-SPAWNED");
      completion = await transport.waitForOutbound({
        conversation: REQUESTER_CONVERSATION,
        sinceIndex: outboundStartIndex,
        textIncludes: COMPLETION_MARKER,
        timeoutMs: 90_000,
      });
    } catch (error) {
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `bus=${JSON.stringify(state.getSnapshot())}`,
          `gateway=${gateway.logs()}`,
        ].join("\n"),
        { cause: error },
      );
    }
    expect(completion.accountId).toBe("default");

    const outbound = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound");
    expect(outbound.some((message) => message.conversation.id === "attacker")).toBe(false);
    expect(outbound.filter((message) => message.text.includes(COMPLETION_MARKER))).toHaveLength(1);
  }, 180_000);
});
