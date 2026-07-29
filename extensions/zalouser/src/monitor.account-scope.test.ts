// Zalouser tests cover monitor.account scope plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import "./monitor.send.test-mocks.js";
import "./zalo-js.test-mocks.js";
import {
  createRawZalouserMessageFromNormalized,
  waitForZalouserIngressVerdict,
  withZalouserIngressTestQueue,
} from "./ingress.test-support.js";
import { monitorZalouserProvider } from "./monitor.js";
import { sendMessageZalouserMock } from "./monitor.send.test-mocks.js";
import { setZalouserRuntime } from "./runtime.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";
import { startZaloListenerMock } from "./zalo-js.test-mocks.js";

type ZaloJsModule = typeof import("./zalo-js.js");
type ListenerParams = Parameters<ZaloJsModule["startZaloListener"]>[0];

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

describe("zalouser monitor pairing account scoping", () => {
  it("scopes DM pairing-store reads and pairing requests to accountId", async () => {
    const readAllowFromStore = vi.fn(
      async (
        channelOrParams:
          | string
          | {
              channel?: string;
              accountId?: string;
            },
        _env?: NodeJS.ProcessEnv,
        accountId?: string,
      ) => {
        const scopedAccountId =
          typeof channelOrParams === "object" && channelOrParams !== null
            ? channelOrParams.accountId
            : accountId;
        return scopedAccountId === "beta" ? [] : ["attacker"];
      },
    );
    const upsertPairingRequest = vi.fn(
      async (_params: { channel: string; id: string; accountId?: string }) => ({
        code: "PAIRME88",
        created: true,
      }),
    );

    setZalouserRuntime({
      logging: {
        shouldLogVerbose: () => false,
      },
      channel: {
        pairing: {
          readAllowFromStore,
          upsertPairingRequest,
          buildPairingReply: vi.fn(() => "pairing reply"),
        },
        commands: {
          shouldComputeCommandAuthorized: vi.fn(() => false),
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
          isControlCommandMessage: vi.fn(() => false),
        },
      },
    } as unknown as PluginRuntime);

    const account: ResolvedZalouserAccount = {
      accountId: "beta",
      enabled: true,
      profile: "beta",
      authenticated: true,
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
      },
    };

    const config: OpenClawConfig = {
      channels: {
        zalouser: {
          accounts: {
            alpha: { dmPolicy: "pairing", allowFrom: [] },
            beta: { dmPolicy: "pairing", allowFrom: [] },
          },
        },
      },
    };

    const message: ZaloInboundMessage = {
      threadId: "chat-1",
      isGroup: false,
      senderId: "attacker",
      senderName: "Attacker",
      groupName: undefined,
      timestampMs: Date.now(),
      msgId: "msg-1",
      content: "hello",
      raw: { source: "test" },
    };

    await withZalouserIngressTestQueue(async (ingressQueue) => {
      const abortController = new AbortController();
      let resolveListener: ((params: ListenerParams) => void) | undefined;
      const listenerReady = new Promise<ListenerParams>((resolve) => {
        resolveListener = resolve;
      });
      startZaloListenerMock.mockImplementationOnce(async (listenerParams) => {
        resolveListener?.(listenerParams);
        return { stop: vi.fn() };
      });
      const run = monitorZalouserProvider({
        account,
        config,
        runtime: createZalouserRuntimeEnv(),
        abortSignal: abortController.signal,
        ingressQueue,
      });
      try {
        const listenerParams = await listenerReady;
        await listenerParams.onMessage(createRawZalouserMessageFromNormalized(message));
        await waitForZalouserIngressVerdict(ingressQueue, "msg-1", "completed");
      } finally {
        abortController.abort();
        await run;
      }
    });

    expect(readAllowFromStore).toHaveBeenCalledOnce();
    const allowStoreParams = requireRecord(
      readAllowFromStore.mock.calls[0]?.[0],
      "allow store params",
    );
    expect(allowStoreParams.channel).toBe("zalouser");
    expect(allowStoreParams.accountId).toBe("beta");

    expect(upsertPairingRequest).toHaveBeenCalledOnce();
    const pairingRequest = requireRecord(
      upsertPairingRequest.mock.calls[0]?.[0],
      "pairing request params",
    );
    expect(pairingRequest.channel).toBe("zalouser");
    expect(pairingRequest.id).toBe("attacker");
    expect(pairingRequest.accountId).toBe("beta");
    expect(sendMessageZalouserMock).toHaveBeenCalled();
  });
});
