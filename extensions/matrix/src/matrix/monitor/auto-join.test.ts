import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import { setMatrixRuntime } from "../../runtime.js";
import type { MatrixConfig } from "../../types.js";
import { registerMatrixAutoJoin } from "./auto-join.js";

type InviteHandler = (roomId: string, inviteEvent: unknown) => Promise<void>;

function createClientStub() {
  let inviteHandler: InviteHandler | null = null;
  const client = {
    on: vi.fn((eventName: string, listener: unknown) => {
      if (eventName === "room.invite") {
        inviteHandler = listener as InviteHandler;
      }
      return client;
    }),
    joinRoom: vi.fn(async () => {}),
    resolveRoom: vi.fn(async () => null),
  } as unknown as import("../sdk.js").MatrixClient;

  return {
    client,
    getInviteHandler: () => inviteHandler,
    joinRoom: (client as unknown as { joinRoom: ReturnType<typeof vi.fn> }).joinRoom,
    resolveRoom: (client as unknown as { resolveRoom: ReturnType<typeof vi.fn> }).resolveRoom,
  };
}

function registerAutoJoinHarness(params: {
  accountConfig?: MatrixConfig;
  resolveRoomValue?: string | null;
  resolveRoomValues?: Array<string | null>;
  error?: ReturnType<typeof vi.fn>;
}) {
  const harness = createClientStub();
  if (params.resolveRoomValues) {
    for (const value of params.resolveRoomValues) {
      harness.resolveRoom.mockResolvedValueOnce(value);
    }
  } else if (params.resolveRoomValue !== undefined) {
    harness.resolveRoom.mockResolvedValue(params.resolveRoomValue);
  }

  registerMatrixAutoJoin({
    client: harness.client,
    accountConfig: params.accountConfig ?? {},
    runtime: {
      log: vi.fn(),
      error: params.error ?? vi.fn(),
    } as unknown as RuntimeEnv,
  });

  return harness;
}

async function triggerInvite(
  getInviteHandler: () => InviteHandler | null,
  inviteEvent: unknown = {},
) {
  const inviteHandler = getInviteHandler();
  if (!inviteHandler) {
    throw new Error("expected Matrix invite handler");
  }
  await inviteHandler("!room:example.org", inviteEvent);
}

describe("registerMatrixAutoJoin", () => {
  beforeEach(() => {
    setMatrixRuntime({
      logging: {
        shouldLogVerbose: () => false,
      },
    } as unknown as PluginRuntime);
  });

  it("joins all invites when autoJoin=always", async () => {
    const { getInviteHandler, joinRoom } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "always",
      },
    });

    await triggerInvite(getInviteHandler);
    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not auto-join invites by default", () => {
    const { getInviteHandler, joinRoom } = registerAutoJoinHarness({});

    expect(getInviteHandler()).toBeNull();
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("ignores invites outside allowlist when autoJoin=allowlist", async () => {
    const { getInviteHandler, joinRoom } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["#allowed:example.org"],
      },
      resolveRoomValue: null,
    });

    await triggerInvite(getInviteHandler);
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("joins invite when allowlisted alias resolves to the invited room", async () => {
    const { getInviteHandler, joinRoom } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: [" #allowed:example.org "],
      },
      resolveRoomValue: "!room:example.org",
    });

    await triggerInvite(getInviteHandler);
    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("retries alias resolution after an unresolved lookup", async () => {
    const { getInviteHandler, joinRoom, resolveRoom } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["#allowed:example.org"],
      },
      resolveRoomValues: [null, "!room:example.org"],
    });

    await triggerInvite(getInviteHandler);
    await triggerInvite(getInviteHandler);

    expect(resolveRoom).toHaveBeenCalledTimes(2);
    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("logs and skips allowlist alias resolution failures", async () => {
    const error = vi.fn();
    const { getInviteHandler, joinRoom, resolveRoom } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["#allowed:example.org"],
      },
      error,
    });
    resolveRoom.mockRejectedValue(new Error("temporary homeserver failure"));

    const inviteHandler = getInviteHandler();
    if (!inviteHandler) {
      throw new Error("expected Matrix invite handler");
    }
    await expect(inviteHandler("!room:example.org", {})).resolves.toBeUndefined();

    expect(joinRoom).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "matrix: failed resolving allowlisted alias #allowed:example.org: Error: temporary homeserver failure",
    );
  });

  it("does not trust room-provided alias claims for allowlist joins", async () => {
    const { getInviteHandler, joinRoom } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["#allowed:example.org"],
      },
      resolveRoomValue: "!different-room:example.org",
    });

    await triggerInvite(getInviteHandler);
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("uses account-scoped auto-join settings for non-default accounts", async () => {
    const { getInviteHandler, joinRoom } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "allowlist",
        autoJoinAllowlist: ["#ops-allowed:example.org"],
      },
      resolveRoomValue: "!room:example.org",
    });

    await triggerInvite(getInviteHandler);
    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("joins sender-scoped invites without eager direct repair", async () => {
    const { getInviteHandler, joinRoom } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "always",
      },
    });

    await triggerInvite(getInviteHandler, { sender: "@alice:example.org" });

    expect(joinRoom).toHaveBeenCalledWith("!room:example.org");
  });

  it("still joins invites when the sender is unavailable", async () => {
    const { getInviteHandler } = registerAutoJoinHarness({
      accountConfig: {
        autoJoin: "always",
      },
    });

    await expect(triggerInvite(getInviteHandler, {})).resolves.toBeUndefined();
  });
});
