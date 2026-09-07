// Mattermost tests cover monitor auth plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());
const resolveAllowlistMatchSimple = vi.hoisted(() => vi.fn());

vi.mock("./runtime-api.js", () => ({
  isDangerousNameMatchingEnabled,
  resolveAllowlistMatchSimple,
}));

describe("mattermost monitor auth", () => {
  let authorizeMattermostCommandInvocation: typeof import("./monitor-auth.js").authorizeMattermostCommandInvocation;
  let formatMattermostDirectMessageDropLog: typeof import("./monitor-auth.js").formatMattermostDirectMessageDropLog;
  let isMattermostSenderAllowed: typeof import("./monitor-auth.js").isMattermostSenderAllowed;
  let normalizeMattermostAllowEntry: typeof import("./ingress-identity.js").normalizeMattermostAllowEntry;

  beforeAll(async () => {
    ({
      authorizeMattermostCommandInvocation,
      formatMattermostDirectMessageDropLog,
      isMattermostSenderAllowed,
    } = await import("./monitor-auth.js"));
    ({ normalizeMattermostAllowEntry } = await import("./ingress-identity.js"));
  });

  beforeEach(() => {
    isDangerousNameMatchingEnabled.mockReset();
    resolveAllowlistMatchSimple.mockReset();
  });

  it("normalizes allowlist entries", () => {
    expect(normalizeMattermostAllowEntry(" @Alice ")).toBe("alice");
    expect(normalizeMattermostAllowEntry("mattermost:Bob")).toBe("bob");
    expect(normalizeMattermostAllowEntry("accessGroup:Ops")).toBe("accessGroup:Ops");
    expect(normalizeMattermostAllowEntry("*")).toBe("*");
  });

  it("checks sender allowlists against normalized ids and names", () => {
    resolveAllowlistMatchSimple.mockReturnValue({ allowed: true });
    expect(
      isMattermostSenderAllowed({
        senderId: "@Alice",
        senderName: "Alice",
        allowFrom: [" mattermost:alice "],
        allowNameMatching: true,
      }),
    ).toBe(true);
    expect(resolveAllowlistMatchSimple).toHaveBeenCalledWith({
      allowFrom: ["alice"],
      senderId: "alice",
      senderName: "alice",
      allowNameMatching: true,
    });
  });

  it("formats direct-message drops with the ingress reason and open-policy hint", () => {
    expect(
      formatMattermostDirectMessageDropLog({
        senderId: "alice-id",
        dmPolicy: "open",
        reasonCode: "dm_policy_not_allowlisted",
      }),
    ).toBe(
      "mattermost: drop dm sender=alice-id (dmPolicy=open reason=dm_policy_not_allowlisted hint=add-allowFrom-wildcard)",
    );
  });

  it("resolves direct command authorization from shared ingress", async () => {
    isDangerousNameMatchingEnabled.mockReturnValue(false);
    resolveAllowlistMatchSimple.mockReturnValue({ allowed: false });

    await expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { dmPolicy: "open" },
        } as never,
        cfg: {} as never,
        senderId: "alice",
        senderName: "Alice",
        channelId: "dm-1",
        channelInfo: { type: "D", name: "alice", display_name: "Alice" } as never,
        allowTextCommands: true,
        hasControlCommand: true,
      }),
    ).resolves.toEqual({
      ok: false,
      denyReason: "unauthorized",
      commandAuthorized: false,
      channelInfo: { type: "D", name: "alice", display_name: "Alice" },
      kind: "direct",
      chatType: "direct",
      channelName: "alice",
      channelDisplay: "Alice",
      roomLabel: "#alice",
    });

    resolveAllowlistMatchSimple.mockReturnValue({ allowed: true });

    await expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { dmPolicy: "open", allowFrom: ["*"] },
        } as never,
        cfg: {} as never,
        senderId: "alice",
        senderName: "Alice",
        channelId: "dm-1",
        channelInfo: { type: "D", name: "alice", display_name: "Alice" } as never,
        allowTextCommands: false,
        hasControlCommand: false,
      }),
    ).resolves.toEqual({
      ok: true,
      commandAuthorized: true,
      channelInfo: { type: "D", name: "alice", display_name: "Alice" },
      kind: "direct",
      chatType: "direct",
      channelName: "alice",
      channelDisplay: "Alice",
      roomLabel: "#alice",
    });

    await expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { dmPolicy: "disabled" },
        } as never,
        cfg: {} as never,
        senderId: "alice",
        senderName: "Alice",
        channelId: "dm-1",
        channelInfo: { type: "D", name: "alice", display_name: "Alice" } as never,
        allowTextCommands: false,
        hasControlCommand: false,
      }),
    ).resolves.toEqual({
      ok: false,
      denyReason: "dm-disabled",
      commandAuthorized: false,
      channelInfo: { type: "D", name: "alice", display_name: "Alice" },
      kind: "direct",
      chatType: "direct",
      channelName: "alice",
      channelDisplay: "Alice",
      roomLabel: "#alice",
    });

    await expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { groupPolicy: "allowlist" },
        } as never,
        cfg: {} as never,
        senderId: "alice",
        senderName: "Alice",
        channelId: "chan-1",
        channelInfo: { type: "O", name: "town-square", display_name: "Town Square" } as never,
        allowTextCommands: true,
        hasControlCommand: false,
      }),
    ).resolves.toEqual({
      ok: false,
      denyReason: "channel-no-allowlist",
      commandAuthorized: false,
      channelInfo: { type: "O", name: "town-square", display_name: "Town Square" },
      kind: "channel",
      chatType: "channel",
      channelName: "town-square",
      channelDisplay: "Town Square",
      roomLabel: "#town-square",
    });
  });

  it("fails closed instead of issuing a pairing challenge when the pairing store read fails", async () => {
    isDangerousNameMatchingEnabled.mockReturnValue(false);
    resolveAllowlistMatchSimple.mockReturnValue({ allowed: false });

    await expect(
      authorizeMattermostCommandInvocation({
        account: {
          config: { dmPolicy: "pairing" },
        } as never,
        cfg: {} as never,
        senderId: "alice",
        senderName: "Alice",
        channelId: "dm-1",
        channelInfo: { type: "D", name: "alice", display_name: "Alice" } as never,
        readStoreAllowFrom: () => Promise.reject(new Error("store unavailable")),
        allowTextCommands: true,
        hasControlCommand: true,
      }),
    ).resolves.toEqual({
      // A read failure must not be indistinguishable from a legitimately empty
      // store: it must not resolve to "dm-pairing" (which would send an
      // already-paired sender a misleading pairing challenge).
      ok: false,
      denyReason: "unauthorized",
      commandAuthorized: false,
      channelInfo: { type: "D", name: "alice", display_name: "Alice" },
      kind: "direct",
      chatType: "direct",
      channelName: "alice",
      channelDisplay: "Alice",
      roomLabel: "#alice",
    });
  });
});
