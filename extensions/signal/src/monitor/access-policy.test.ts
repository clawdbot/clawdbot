import { describe, expect, it, vi } from "vitest";
import { handleSignalDirectMessageAccess } from "./access-policy.js";

describe("handleSignalDirectMessageAccess", () => {
  it("returns true for already-allowed direct messages", async () => {
    await expect(
      handleSignalDirectMessageAccess({
        dmPolicy: "open",
        dmAccessDecision: "allow",
        senderId: "+15551230000",
        senderIdLine: "Signal number: +15551230000",
        senderDisplay: "Alice",
        accountId: "default",
        sendPairingReply: async () => {},
        log: () => {},
      }),
    ).resolves.toBe(true);
  });

  it("issues a pairing challenge for pairing-gated senders", async () => {
    const replies: string[] = [];
    const sendPairingReply = vi.fn(async (text: string) => {
      replies.push(text);
    });

    await expect(
      handleSignalDirectMessageAccess({
        dmPolicy: "pairing",
        dmAccessDecision: "pairing",
        senderId: "+15551230000",
        senderIdLine: "Signal number: +15551230000",
        senderDisplay: "Alice",
        senderName: "Alice",
        accountId: "default",
        sendPairingReply,
        log: () => {},
      }),
    ).resolves.toBe(false);

    expect(sendPairingReply).toHaveBeenCalledTimes(1);
    expect(replies[0]).toContain("Pairing code:");
  });
});
