import { describe, expect, it } from "vitest";
import {
  resolveMatrixMonitorAccessState,
  resolveMatrixMonitorCommandAccess,
} from "./access-state.js";

async function expectCommandAccess(
  state: Parameters<typeof resolveMatrixMonitorCommandAccess>[0],
  params: Parameters<typeof resolveMatrixMonitorCommandAccess>[1],
  expected: { authorized: boolean; shouldBlockControlCommand: boolean },
): Promise<void> {
  const access = await resolveMatrixMonitorCommandAccess(state, params);

  expect(access.authorized).toBe(expected.authorized);
  expect(access.shouldBlockControlCommand).toBe(expected.shouldBlockControlCommand);
}

describe("resolveMatrixMonitorAccessState", () => {
  it("normalizes group allowlists and uses shared ingress matching", async () => {
    const state = await resolveMatrixMonitorAccessState({
      allowFrom: ["matrix:@Alice:Example.org"],
      storeAllowFrom: ["user:@bob:example.org"],
      groupAllowFrom: ["@Carol:Example.org"],
      roomUsers: ["user:@Dana:Example.org"],
      senderId: "@dana:example.org",
      isRoom: true,
      groupPolicy: "allowlist",
    });

    expect(state.effectiveGroupAllowFrom).toEqual(["@carol:example.org"]);
    expect(state.effectiveRoomUsers).toEqual(["user:@dana:example.org"]);
    expect(state.messageIngress.ingress.decision).toBe("allow");
  });

  it("does not let DM pairing-store entries authorize room control commands", async () => {
    const state = await resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: ["@attacker:example.org"],
      groupAllowFrom: [],
      roomUsers: [],
      senderId: "@attacker:example.org",
      isRoom: true,
    });

    await expectCommandAccess(
      state,
      {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
      { authorized: false, shouldBlockControlCommand: true },
    );
  });

  it("does not let pairing-store entries authorize open DMs without wildcard", async () => {
    const state = await resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: ["@alice:example.org"],
      dmPolicy: "open",
      groupAllowFrom: [],
      roomUsers: [],
      senderId: "@alice:example.org",
      isRoom: false,
    });

    expect(state.messageIngress.senderAccess.effectiveAllowFrom).toEqual([]);
    expect(state.messageIngress.senderAccess.decision).toBe("block");
    expect(state.messageIngress.ingress.reasonCode).toBe("dm_policy_not_allowlisted");
  });

  it("does not let configured DM allowFrom authorize room control commands", async () => {
    const state = await resolveMatrixMonitorAccessState({
      allowFrom: ["@owner:example.org"],
      storeAllowFrom: [],
      groupAllowFrom: ["@admin:example.org"],
      roomUsers: [],
      senderId: "@owner:example.org",
      isRoom: true,
    });

    await expectCommandAccess(
      state,
      {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
      { authorized: false, shouldBlockControlCommand: true },
    );
  });

  it("treats unresolved configured room allowlists as configured but nonmatching", async () => {
    const groupState = await resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: [],
      groupAllowFrom: ["Alice"],
      roomUsers: [],
      senderId: "@alice:example.org",
      isRoom: true,
      groupPolicy: "allowlist",
    });
    const roomState = await resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: [],
      groupAllowFrom: [],
      roomUsers: ["Dana"],
      senderId: "@dana:example.org",
      isRoom: true,
      groupPolicy: "open",
    });

    expect(groupState.effectiveGroupAllowFrom).toEqual(["alice"]);
    expect(groupState.messageIngress.ingress.decision).toBe("block");
    expect(groupState.messageIngress.ingress.reasonCode).toBe("group_policy_not_allowlisted");
    expect(roomState.effectiveRoomUsers).toEqual(["dana"]);
    expect(roomState.messageIngress.ingress.decision).toBe("block");
    expect(roomState.messageIngress.ingress.reasonCode).toBe("group_policy_not_allowlisted");
    await expectCommandAccess(
      groupState,
      {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
      { authorized: false, shouldBlockControlCommand: true },
    );
    await expectCommandAccess(
      roomState,
      {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
      { authorized: false, shouldBlockControlCommand: true },
    );
  });

  it("authorizes room control commands through the shared ingress command gate", async () => {
    const state = await resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: [],
      groupAllowFrom: ["@admin:example.org"],
      roomUsers: [],
      senderId: "@admin:example.org",
      isRoom: true,
    });

    await expectCommandAccess(
      state,
      {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
      { authorized: true, shouldBlockControlCommand: false },
    );
  });

  it("keeps command allow mode when access groups are disabled", async () => {
    const state = await resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: [],
      groupAllowFrom: [],
      roomUsers: [],
      senderId: "@admin:example.org",
      isRoom: true,
    });

    await expectCommandAccess(
      state,
      {
        useAccessGroups: false,
        allowTextCommands: true,
        hasControlCommand: true,
      },
      { authorized: true, shouldBlockControlCommand: false },
    );
  });

  it("keeps room-user allowlists out of dm traffic", async () => {
    const state = await resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: [],
      groupAllowFrom: ["@carol:example.org"],
      roomUsers: ["@dana:example.org"],
      senderId: "@dana:example.org",
      isRoom: false,
    });

    expect(state.messageIngress.senderAccess.decision).toBe("pairing");
    await expectCommandAccess(
      state,
      {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
      { authorized: false, shouldBlockControlCommand: true },
    );
  });

  it("uses the shared ingress decision for room user sender gates", async () => {
    const blocked = await resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: [],
      groupAllowFrom: [],
      roomUsers: ["@allowed:example.org"],
      senderId: "@blocked:example.org",
      isRoom: true,
      groupPolicy: "open",
    });
    const allowed = await resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: [],
      groupAllowFrom: [],
      roomUsers: ["@allowed:example.org"],
      senderId: "@allowed:example.org",
      isRoom: true,
      groupPolicy: "open",
    });

    expect(blocked.messageIngress.ingress.reasonCode).toBe("group_policy_not_allowlisted");
    expect(allowed.messageIngress.ingress.decision).toBe("allow");
  });

  it("keeps route-only room allowlists open when no sender allowlist exists", async () => {
    const state = await resolveMatrixMonitorAccessState({
      allowFrom: [],
      storeAllowFrom: [],
      groupAllowFrom: [],
      roomUsers: [],
      senderId: "@sender:example.org",
      isRoom: true,
      groupPolicy: "allowlist",
    });

    expect(state.messageIngress.ingress.decision).toBe("allow");
    expect(state.messageIngress.ingress.reasonCode).toBe("activation_allowed");
  });
});
