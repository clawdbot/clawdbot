// Qa Lab integration tests cover the real QA Channel runtime contract.
import { qaChannelPlugin, setQaChannelRuntime } from "@openclaw/qa-channel/api.js";
import { describe, expect, it, vi } from "vitest";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaRunnerRuntime } from "./harness-runtime.js";
import { createQaChannelGatewayConfig } from "./qa-channel-transport.js";

describe("QA runner runtime integration", () => {
  it("dispatches a QA Channel inbound turn through the embedded runner", async () => {
    const state = createQaBusState();
    const bus = await startQaBusServer({ state });
    const runtime = createQaRunnerRuntime();
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

    try {
      state.addInboundMessage({
        accountId: "default",
        conversation: { kind: "direct", id: "alice" },
        senderId: "alice",
        senderName: "Alice",
        text: "ping",
      });

      await Promise.race([
        vi.waitFor(
          () => {
            expect(state.getSnapshot().messages).toContainEqual(
              expect.objectContaining({ direction: "outbound", text: "qa-echo: ping" }),
            );
          },
          { interval: 25, timeout: 2_000 },
        ),
        gatewayTask.then(() => {
          throw new Error("QA Channel gateway stopped before delivering the turn");
        }),
      ]);
    } finally {
      abort.abort();
      try {
        await gatewayTask;
      } finally {
        await bus.stop();
      }
    }
  });
});
