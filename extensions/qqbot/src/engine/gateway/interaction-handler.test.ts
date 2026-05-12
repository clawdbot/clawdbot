import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPlatformAdapter, type PlatformAdapter } from "../adapter/index.js";
import type { InteractionEvent } from "../types.js";
import { createInteractionHandler } from "./interaction-handler.js";
import type { GatewayAccount, GatewayPluginRuntime } from "./types.js";

const acknowledgeInteractionMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../messaging/sender.js", () => ({
  accountToCreds: (account: GatewayAccount) => ({
    appId: account.appId,
    clientSecret: account.clientSecret,
  }),
  acknowledgeInteraction: acknowledgeInteractionMock,
}));

const resolveApprovalMock = vi.fn(async () => true);

const account: GatewayAccount = {
  accountId: "default",
  appId: "app",
  clientSecret: "secret",
  markdownSupport: false,
  config: {},
};

const runtime = {} as GatewayPluginRuntime;

function makeRestrictedCfg(approvers: string[]): OpenClawConfig {
  return {
    channels: {
      qqbot: {
        appId: "app",
        clientSecret: "secret",
        execApprovals: {
          enabled: true,
          approvers,
        },
      },
    },
  } as OpenClawConfig;
}

function makeUnrestrictedCfg(): OpenClawConfig {
  return {
    channels: {
      qqbot: {
        appId: "app",
        clientSecret: "secret",
      },
    },
  } as OpenClawConfig;
}

function makeApprovalEvent(overrides: Partial<InteractionEvent> = {}): InteractionEvent {
  return {
    id: "interaction-1",
    type: 11,
    chat_type: 1,
    group_openid: "group-1",
    group_member_openid: "ATTACKER_OPENID",
    version: 1,
    data: {
      type: 11,
      resolved: {
        button_data: "approve:exec:abc12345:allow-once",
        user_id: "ATTACKER_USER_ID",
      },
    },
    ...overrides,
  };
}

function installPlatformAdapter(): void {
  registerPlatformAdapter({
    validateRemoteUrl: vi.fn(async () => undefined),
    resolveSecret: vi.fn(async (value: unknown) => (typeof value === "string" ? value : undefined)),
    downloadFile: vi.fn(async () => "/tmp/file"),
    fetchMedia: vi.fn(async () => {
      throw new Error("unused");
    }),
    getTempDir: () => "/tmp",
    hasConfiguredSecret: (value: unknown) => typeof value === "string" && value.length > 0,
    normalizeSecretInputString: (value: unknown) => (typeof value === "string" ? value : undefined),
    resolveSecretInputString: ({ value }: { value: unknown }) =>
      typeof value === "string" ? value : undefined,
    resolveApproval: resolveApprovalMock,
  } as PlatformAdapter);
}

describe("createInteractionHandler approval buttons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installPlatformAdapter();
  });

  it("rejects approval button clicks from users outside the configured approvers", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(makeApprovalEvent());

    await vi.waitFor(() => expect(acknowledgeInteractionMock).toHaveBeenCalled());

    expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
      { appId: "app", clientSecret: "secret" },
      "interaction-1",
      0,
      { content: "You are not authorized to approve this request." },
    );
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });

  it("does not authorize from resolved user id when the actor openid is not approved", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(
      makeApprovalEvent({
        data: {
          type: 11,
          resolved: {
            button_data: "approve:exec:abc12345:allow-once",
            user_id: "OWNER_OPENID",
          },
        },
      }),
    );

    await vi.waitFor(() => expect(acknowledgeInteractionMock).toHaveBeenCalled());

    expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
      { appId: "app", clientSecret: "secret" },
      "interaction-1",
      0,
      { content: "You are not authorized to approve this request." },
    );
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });

  it("resolves approval button clicks from configured approvers", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(makeApprovalEvent({ group_member_openid: "OWNER_OPENID" }));

    await vi.waitFor(() =>
      expect(resolveApprovalMock).toHaveBeenCalledWith("exec:abc12345", "allow-once"),
    );
  });

  it("uses the direct user openid when a group member openid is unavailable", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeRestrictedCfg(["OWNER_OPENID"]),
    });

    handler(
      makeApprovalEvent({
        chat_type: 2,
        group_openid: undefined,
        group_member_openid: undefined,
        user_openid: "OWNER_OPENID",
      }),
    );

    await vi.waitFor(() =>
      expect(resolveApprovalMock).toHaveBeenCalledWith("exec:abc12345", "allow-once"),
    );
  });

  it("allows approval button clicks when exec approvals are not configured", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => makeUnrestrictedCfg(),
    });

    handler(makeApprovalEvent());

    await vi.waitFor(() =>
      expect(resolveApprovalMock).toHaveBeenCalledWith("exec:abc12345", "allow-once"),
    );
  });

  it("rejects approval button clicks when active config cannot be loaded", async () => {
    const handler = createInteractionHandler(account, runtime, undefined, {
      getActiveCfg: () => {
        throw new Error("config unavailable");
      },
    });

    handler(makeApprovalEvent());

    await vi.waitFor(() => expect(acknowledgeInteractionMock).toHaveBeenCalled());

    expect(acknowledgeInteractionMock).toHaveBeenCalledWith(
      { appId: "app", clientSecret: "secret" },
      "interaction-1",
      0,
      { content: "Approval is unavailable." },
    );
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });
});
