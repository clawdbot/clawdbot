import { describe, expect, it } from "vitest";
import { resolveTerminalReplySilenceContract } from "./get-reply-run-helpers.js";

describe("resolveTerminalReplySilenceContract", () => {
  it("declares the heartbeat silence contract so reasoning-only stops settle as silence", () => {
    // A heartbeat may legitimately have nothing to report. Its run params must
    // carry that contract explicitly: leaving it to the runner's trigger-owned
    // default classifies a reasoning-only stop as a provider failure and the
    // visible-answer retry force-delivers an unsolicited channel message.
    expect(
      resolveTerminalReplySilenceContract({
        isHeartbeat: true,
        isGroupChat: false,
        isDirectedTurn: false,
        isAmbientRoomEvent: false,
        silentReplyPolicy: "disallow",
      }),
    ).toEqual({ allowEmptyAssistantReplyAsSilent: true, terminalReplyExpectation: "optional" });
  });

  it("keeps ambient room events silent-capable without a heartbeat", () => {
    expect(
      resolveTerminalReplySilenceContract({
        isHeartbeat: false,
        isGroupChat: true,
        isDirectedTurn: false,
        isAmbientRoomEvent: true,
        silentReplyPolicy: "disallow",
      }),
    ).toEqual({ allowEmptyAssistantReplyAsSilent: true, terminalReplyExpectation: "optional" });
  });

  it("keeps directed group and direct-chat turns owed a visible reply", () => {
    expect(
      resolveTerminalReplySilenceContract({
        isHeartbeat: false,
        isGroupChat: true,
        isDirectedTurn: true,
        isAmbientRoomEvent: false,
        silentReplyPolicy: "allow",
      }),
    ).toEqual({ allowEmptyAssistantReplyAsSilent: false, terminalReplyExpectation: "required" });
    expect(
      resolveTerminalReplySilenceContract({
        isHeartbeat: false,
        isGroupChat: false,
        isDirectedTurn: false,
        isAmbientRoomEvent: false,
        silentReplyPolicy: "allow",
      }),
    ).toEqual({ allowEmptyAssistantReplyAsSilent: false, terminalReplyExpectation: "required" });
  });
});
