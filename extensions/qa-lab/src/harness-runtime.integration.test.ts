// Qa Lab integration tests cover the real QA Channel runtime contract.
import { qaChannelPlugin, setQaChannelRuntime } from "@openclaw/qa-channel/api.js";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaRunnerRuntime } from "./harness-runtime.js";
import { createQaChannelGatewayConfig, createQaChannelTransport } from "./qa-channel-transport.js";

async function startQaRuntimeIntegration(runtime = createQaRunnerRuntime()) {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "qa-channel", plugin: qaChannelPlugin, source: "test" }]),
  );
  const state = createQaBusState();
  const bus = await startQaBusServer({ state });
  setQaChannelRuntime(runtime);
  const config = createQaChannelGatewayConfig({ baseUrl: bus.baseUrl });
  const account = qaChannelPlugin.config.resolveAccount(config, "default");
  const abort = new AbortController();
  const startAccount = qaChannelPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("QA Channel gateway is unavailable");
  }
  const gatewayTask = startAccount({
    accountId: account.accountId,
    account,
    cfg: config,
    runtime: {
      log: () => undefined,
      error: () => undefined,
      exit: () => undefined,
    },
    abortSignal: abort.signal,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    getStatus: () => ({
      accountId: account.accountId,
      configured: true,
      enabled: true,
      running: true,
    }),
    setStatus: () => undefined,
  });
  return {
    state,
    gatewayTask,
    async stop() {
      abort.abort();
      try {
        await gatewayTask;
      } finally {
        await bus.stop();
      }
    },
  };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("QA runner runtime integration", () => {
  it("dispatches a QA Channel inbound turn through the embedded runner", async () => {
    const harness = await startQaRuntimeIntegration();

    try {
      harness.state.addInboundMessage({
        accountId: "default",
        conversation: { kind: "direct", id: "alice" },
        senderId: "alice",
        senderName: "Alice",
        text: "ping",
      });

      const outbound = await Promise.race([
        harness.state.waitFor({
          kind: "message-text",
          direction: "outbound",
          textIncludes: "qa-echo: ping",
        }),
        harness.gatewayTask.then(() => {
          throw new Error("QA Channel gateway stopped before delivering the turn");
        }),
      ]);
      expect(outbound).toMatchObject({ direction: "outbound", text: "qa-echo: ping" });
    } finally {
      await harness.stop();
    }
  });

  it("marks and detects text-only errors across QA delivery paths", async () => {
    const failureText = "Text-only QA failure from the embedded runner.";
    const runtime = createQaRunnerRuntime();
    const dispatchFailure = async (
      params: Parameters<typeof runtime.channel.inbound.dispatch>[0],
    ) => {
      if (!("deliver" in params.delivery) || typeof params.delivery.deliver !== "function") {
        throw new Error("QA failure fixture requires core-managed delivery");
      }
      await params.delivery.deliver({ text: failureText, isError: true }, { kind: "final" });
      return {
        admission: params.admission ?? { kind: "dispatch" as const },
        dispatched: true,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.route.sessionKey,
        dispatchResult: {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 1 },
        },
      };
    };
    runtime.channel.inbound.dispatch = dispatchFailure as typeof runtime.channel.inbound.dispatch;
    const harness = await startQaRuntimeIntegration(runtime);
    const transport = createQaChannelTransport(harness.state);
    let sent = false;

    try {
      expect(qaChannelPlugin.outbound?.sendTextOnlyErrorPayloads).toBe(true);
      await Promise.race([
        expect(
          transport.waitForCondition(
            async () => {
              if (!sent) {
                sent = true;
                harness.state.addInboundMessage({
                  accountId: "default",
                  conversation: { kind: "direct", id: "alice" },
                  senderId: "alice",
                  senderName: "Alice",
                  text: "trigger a text-only failure",
                });
              }
              return undefined;
            },
            2_000,
            25,
          ),
        ).rejects.toThrow(failureText),
        harness.gatewayTask.then(() => {
          throw new Error("QA Channel gateway stopped before delivering the failure");
        }),
      ]);
      expect(harness.state.getSnapshot().messages).toContainEqual(
        expect.objectContaining({ direction: "outbound", text: failureText, isError: true }),
      );
    } finally {
      await harness.stop();
    }
  });
});
