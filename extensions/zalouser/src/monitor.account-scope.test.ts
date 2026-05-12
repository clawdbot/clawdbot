import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import "./monitor.send-mocks.js";
import { __testing } from "./monitor.js";
import "./zalo-js.test-mocks.js";
import { sendMessageZalouserMock } from "./monitor.send-mocks.js";
import { setZalouserRuntime } from "./runtime.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";

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

    await __testing.processMessage({
      message,
      account,
      config,
      runtime: createZalouserRuntimeEnv(),
    });

    expect(readAllowFromStore).toHaveBeenCalledOnce();
    const allowStoreParams = requireRecord(
      readAllowFromStore.mock.calls.at(0)?.[0],
      "allow store params",
    );
    expect(allowStoreParams.channel).toBe("zalouser");
    expect(allowStoreParams.accountId).toBe("beta");

    expect(upsertPairingRequest).toHaveBeenCalledOnce();
    const pairingRequest = requireRecord(
      upsertPairingRequest.mock.calls.at(0)?.[0],
      "pairing request params",
    );
    expect(pairingRequest.channel).toBe("zalouser");
    expect(pairingRequest.id).toBe("attacker");
    expect(pairingRequest.accountId).toBe("beta");
    expect(sendMessageZalouserMock).toHaveBeenCalled();
  });
});
