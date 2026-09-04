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
        { cloudProfileId: "", deviceId: "runner", autoDevice: false, machineClass: "" },
      ).target,
    ).toEqual({ kind: "device", deviceId: "runner" });
  });

  it("preserves automatic device selection through the draft placement target", () => {
    expect(
      resolveDraftSessionPlacement(
        { sessionKey: "", target: null },
        { cloudProfileId: "", deviceId: "", autoDevice: true, machineClass: "" },
      ).target,
    ).toEqual({ kind: "auto-device" });
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

  it("restores draft visibility and capability choices from a creating recovery", () => {
    expect(
      projectDraftSessionPlacementRecovery({
        sessionKey: "agent:main:cloud",
        messageId: "message-cloud",
        message: "continue in the cloud",
        target: { kind: "profile", profileId: "aws" },
        agentId: "main",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "creating",
        createParams: {
          key: "agent:main:cloud",
          agentId: "main",
          message: "",
          permissionMode: "guarded",
          visibility: "draft",
          toolOverrides: { skills: { release: false } },
          worktree: true,
        },
      }),
    ).toMatchObject({
      draft: {
        permissionMode: "guarded",
        visibility: "draft",
        toolOverrides: { skills: { release: false } },
      },
    });
  });
});
