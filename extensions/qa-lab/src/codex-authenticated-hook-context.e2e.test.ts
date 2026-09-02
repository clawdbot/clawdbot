import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { startQaMockOpenAiServer } from "./providers/mock-openai/server.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";

const PLUGIN_ID = "qa-codex-hook-context-proof";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PLUGIN_DIR = path.join(
  REPO_ROOT,
  "extensions/qa-lab/test-fixtures/codex-hook-context-proof-plugin",
);
const CONVERSATION = { id: "authenticated-team-room", kind: "direct" as const };

type CapturedContext = {
  accountId?: string;
  senderId?: string;
  chatId?: string;
  channel?: string;
  sessionKey?: string;
  channelContext?: Record<string, unknown>;
};

type HookCaptures = {
  beforePromptBuild: CapturedContext[];
  beforeCompaction: CapturedContext[];
  afterCompaction: CapturedContext[];
};

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
        [PLUGIN_ID]: {
          enabled: true,
          hooks: {
            allowConversationAccess: true,
            allowPromptInjection: true,
          },
        },
      },
    },
  };
}

function expectAuthenticatedContext(ctx: CapturedContext | undefined) {
  expect(ctx).toMatchObject({
    accountId: "default",
    senderId: "ahmad",
    chatId: CONVERSATION.id,
    channel: "qa-channel",
    channelContext: {
      sender: { id: "ahmad" },
      chat: { id: CONVERSATION.id },
    },
  });
  expect(ctx?.sessionKey).toBe("agent:qa:main");
}

describe("Codex authenticated hook context product proof", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it("preserves admitted qa-channel identity through prompt and native compaction hooks", async () => {
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
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      forcedRuntime: "codex",
      codexMockAutoCompactTokenLimit: 1,
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
      conversation: CONVERSATION,
      senderId: "ahmad",
      senderName: "Ahmad",
      text: `Preserve this authenticated sender while compacting. ${"context ".repeat(8_000)}`,
    });
    await transport.waitForOutbound({
      conversation: CONVERSATION,
      sinceIndex: outboundStartIndex,
      timeoutMs: 120_000,
    });
    const secondOutboundIndex = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound").length;
    await transport.sendInbound({
      accountId: "default",
      conversation: CONVERSATION,
      senderId: "ahmad",
      senderName: "Ahmad",
      text: "Continue after preserving the authenticated sender.",
    });
    await transport.waitForOutbound({
      conversation: CONVERSATION,
      sinceIndex: secondOutboundIndex,
      timeoutMs: 120_000,
    });

    const response = await fetch(`${gateway.baseUrl}/qa/codex-hook-context-proof`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.status).toBe(200);
    const captures = (await response.json()) as HookCaptures;
    expectAuthenticatedContext(captures.beforePromptBuild.at(-1));
    expect(captures.beforeCompaction.length).toBeGreaterThan(0);
    expect(captures.afterCompaction.length).toBeGreaterThan(0);
    expectAuthenticatedContext(captures.beforeCompaction.at(-1));
    expectAuthenticatedContext(captures.afterCompaction.at(-1));
    const verdictPath = process.env.OPENCLAW_QA_VERDICT_PATH?.trim();
    if (verdictPath) {
      await fs.mkdir(path.dirname(verdictPath), { recursive: true });
      await fs.writeFile(
        verdictPath,
        `${JSON.stringify(
          {
            scenario: "codex-authenticated-hook-context",
            passed: true,
            channel: "qa-channel",
            provider: "mock-openai",
            runtime: "codex",
            gateway: "ephemeral-child-process",
            captures: {
              beforePromptBuild: captures.beforePromptBuild.length,
              beforeCompaction: captures.beforeCompaction.length,
              afterCompaction: captures.afterCompaction.length,
            },
            authenticatedContext: captures.afterCompaction.at(-1),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
  }, 240_000);
});
