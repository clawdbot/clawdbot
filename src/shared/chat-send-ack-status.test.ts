import { describe, expect, it } from "vitest";
import { normalizeTerminalChatSendAckStatus } from "./chat-send-ack-status.js";

describe("normalizeTerminalChatSendAckStatus", () => {
  it.each<[unknown, "ok" | "timeout" | "error" | undefined]>([
    ["ok", "ok"],
    ["timeout", "timeout"],
    ["error", "error"],
    ["ERROR", "error"],
    [" timeout ", "timeout"],
    ["started", undefined],
    ["", undefined],
    [42, undefined],
    [null, undefined],
    [{}, undefined],
  ])("normalizes %j to %s", (status, expected) => {
    expect(normalizeTerminalChatSendAckStatus(status)).toBe(expected);
  });
});
