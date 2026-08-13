import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buzzPlugin } from "./channel.js";

describe("Buzz channel guidance", () => {
  it("advertises directory room targets and native mention syntax", () => {
    const hints = buzzPlugin.agentPrompt?.messageToolHints?.({} as never) ?? [];

    expect(hints).toContain(
      "- Buzz targets: use a configured room UUID, `buzz:<ROOM_UUID>`, or a unique current room name. Use the UUID when room names are ambiguous.",
    );
    expect(hints).toContain(
      "- Buzz mentions: write a unique current room member as `@Display Name`. For an explicit identity, include `nostr:npub...`; the public key must belong to the target room. Any unresolved or ambiguous label needs an explicit identity for every intended member.",
    );
    expect(buzzPlugin.messaging?.targetResolver?.hint).toBe("<room UUID|configured room name>");
  });

  it("resolves Buzz reply sessions without treating the thread as part of the room UUID", () => {
    const roomId = "64f4debf-e7af-438c-8dcd-d6fbbe77405d";
    const threadId = "584e8d00bab48310ea80ff5f62550f824242bbc333fc4c259d7ae80be025c8aa";

    expect(
      buzzPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: `buzz:${roomId}:thread:${threadId}`,
      }),
    ).toEqual({
      id: roomId,
      threadId,
      baseConversationId: roomId,
      parentConversationCandidates: [roomId],
    });
  });

  it("uses the configured default account for outbound session routes", async () => {
    const roomId = "64f4debf-e7af-438c-8dcd-d6fbbe77405d";
    const route = await buzzPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {
        session: { dmScope: "per-account-channel-peer" },
        channels: {
          buzz: {
            defaultAccount: "ada",
            accounts: {
              ada: { relayUrl: "wss://ada.example.com", privateKey: "22".repeat(32) },
            },
          },
        },
      } as OpenClawConfig,
      agentId: "main",
      accountId: "ADA",
      target: roomId,
    });

    expect(route?.from).toBe("buzz:ada");
  });

  it("updates and deletes named accounts through the shared config adapter", () => {
    const cfg = {
      channels: {
        buzz: {
          accounts: {
            default: { relayUrl: "wss://default.example.com", privateKey: "11".repeat(32) },
            ada: { relayUrl: "wss://ada.example.com", privateKey: "22".repeat(32) },
          },
        },
      },
    } as OpenClawConfig;

    const disabled = buzzPlugin.config.setAccountEnabled?.({
      cfg,
      accountId: "ada",
      enabled: false,
    });
    expect(disabled?.channels?.buzz?.accounts?.ada?.enabled).toBe(false);
    expect(disabled?.channels?.buzz?.accounts?.default?.privateKey).toBe("11".repeat(32));

    const deleted = buzzPlugin.config.deleteAccount?.({ cfg: disabled!, accountId: "ada" });
    expect(deleted?.channels?.buzz?.accounts?.ada).toBeUndefined();
    expect(deleted?.channels?.buzz?.accounts?.default?.privateKey).toBe("11".repeat(32));
  });

  it("updates and deletes the scoped default account without disabling named accounts", () => {
    const cfg = {
      channels: {
        buzz: {
          enabled: true,
          accounts: {
            default: { relayUrl: "wss://default.example.com", privateKey: "11".repeat(32) },
            ada: { relayUrl: "wss://ada.example.com", privateKey: "22".repeat(32) },
          },
        },
      },
    } as OpenClawConfig;

    const disabled = buzzPlugin.config.setAccountEnabled?.({
      cfg,
      accountId: "default",
      enabled: false,
    });
    expect(disabled?.channels?.buzz?.enabled).toBe(true);
    expect(disabled?.channels?.buzz?.accounts?.default?.enabled).toBe(false);
    expect(disabled?.channels?.buzz?.accounts?.ada?.enabled).toBeUndefined();

    const deleted = buzzPlugin.config.deleteAccount?.({ cfg, accountId: "default" });
    expect(deleted?.channels?.buzz?.enabled).toBe(true);
    expect(deleted?.channels?.buzz?.accounts?.default).toBeUndefined();
    expect(deleted?.channels?.buzz?.accounts?.ada?.privateKey).toBe("22".repeat(32));
  });
});
