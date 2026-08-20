// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  projectDraftSessionPlacementRecovery,
  resolveDraftSessionPlacement,
} from "./draft-session-placement.ts";

describe("new-session placement target", () => {
  it("resolves a selected paired device through the generic placement target", () => {
    expect(
      resolveDraftSessionPlacement(
        { sessionKey: "", target: null },
        { cloudProfileId: "", deviceId: "runner", machineClass: "" },
      ).target,
    ).toEqual({ kind: "device", deviceId: "runner" });
  });

  it("restores a device recovery into the same draft placement owner", () => {
    expect(
      projectDraftSessionPlacementRecovery({
        sessionKey: "agent:main:device",
        messageId: "message-device",
        message: "continue on the runner",
        target: { kind: "device", deviceId: "runner" },
        agentId: "main",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "dispatching",
      }),
    ).toMatchObject({
      placement: { agentId: "main", profileId: "", deviceId: "runner" },
      draft: { message: "continue on the runner" },
    });
  });
});
