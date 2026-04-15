import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import "./monitor.send-mocks.js";
import { __testing } from "./monitor.js";
import "./zalo-js.test-mocks.js";
import { sendMessageZalouserMock } from "./monitor.send-mocks.js";
import { setZalouserRuntime } from "./runtime.js";
import { createZalouserRuntimeEnv } from "./test-helpers.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";

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
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIRME88", created: true }));

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

    expect(readAllowFromStore).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "zalouser",
        accountId: "beta",
      }),
    );
    expect(upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "zalouser",
        id: "attacker",
        accountId: "beta",
      }),
    );
    expect(sendMessageZalouserMock).toHaveBeenCalled();
  });
});
