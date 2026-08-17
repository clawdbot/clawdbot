import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareApprovalChannelCustody } from "./approval-channel-custody.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  listAccountIds: vi.fn(),
  defaultAccountId: vi.fn(),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: () => ({
    config: {
      listAccountIds: mocks.listAccountIds,
      defaultAccountId: mocks.defaultAccountId,
    },
  }),
  resolveChannelApprovalCapability: () => ({ authorizeActorAction: mocks.authorize }),
}));

const reviewer = (accountId: string) => ({
  channel: "telegram",
  accountId,
  senderId: "owner",
});

const request = (payload: {
  command: string;
  turnSourceChannel?: string;
  turnSourceAccountId?: string;
}) => ({ id: "approval-1", request: payload, createdAtMs: 1, expiresAtMs: 2 });

describe("prepareApprovalChannelCustody", () => {
  beforeEach(() => {
    mocks.authorize.mockReset().mockReturnValue({ authorized: true });
    mocks.listAccountIds.mockReset().mockReturnValue(["default", "ops"]);
    mocks.defaultAccountId.mockReset().mockReturnValue("default");
  });

  it("authorizes only the account recorded by the request source", () => {
    const approval = request({
      command: "printf approval",
      turnSourceChannel: "telegram",
      turnSourceAccountId: "ops",
    });
    expect(
      prepareApprovalChannelCustody({
        cfg: {},
        approvalKind: "exec",
        reviewer: reviewer("ops"),
      })?.authorizes(approval),
    ).toBe(true);
    expect(
      prepareApprovalChannelCustody({
        cfg: {},
        approvalKind: "exec",
        reviewer: reviewer("default"),
      })?.authorizes(approval),
    ).toBe(false);
  });

  it("unions explicit scoped targets with the documented default account", () => {
    const cfg: OpenClawConfig = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [
            { channel: "telegram", to: "1" },
            { channel: "telegram", to: "2", accountId: "ops" },
          ],
        },
      },
    };
    mocks.listAccountIds.mockReturnValue(["default", "ops", "other"]);
    for (const accountId of ["default", "ops"]) {
      expect(
        prepareApprovalChannelCustody({
          cfg,
          approvalKind: "exec",
          reviewer: reviewer(accountId),
        })?.authorizes(request({ command: "printf approval" })),
      ).toBe(true);
    }
    expect(
      prepareApprovalChannelCustody({
        cfg,
        approvalKind: "exec",
        reviewer: reviewer("other"),
      })?.authorizes(request({ command: "printf approval" })),
    ).toBe(false);
  });

  it("allows an unbound request only for one actor-authorized account", () => {
    mocks.authorize.mockImplementation(({ accountId }) => ({ authorized: accountId === "ops" }));
    expect(
      prepareApprovalChannelCustody({
        cfg: {},
        approvalKind: "exec",
        reviewer: reviewer("ops"),
      })?.authorizes(request({ command: "printf approval" })),
    ).toBe(true);

    mocks.authorize.mockReturnValue({ authorized: true });
    expect(
      prepareApprovalChannelCustody({
        cfg: {},
        approvalKind: "exec",
        reviewer: reviewer("ops"),
      })?.authorizes(request({ command: "printf approval" })),
    ).toBe(false);
  });
});
