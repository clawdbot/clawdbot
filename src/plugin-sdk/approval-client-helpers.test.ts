import { describe, expect, it } from "vitest";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
} from "./approval-client-helpers.js";
import type { OpenClawConfig } from "./config-runtime.js";

describe("isChannelExecApprovalTargetRecipient", () => {
  it("matches targets by channel and account", () => {
    const cfg: OpenClawConfig = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [
            { channel: "matrix", to: "user:@owner:example.org", accountId: "ops" },
            { channel: "matrix", to: "user:@other:example.org", accountId: "other" },
          ],
        },
      },
    };

    expect(
      isChannelExecApprovalTargetRecipient({
        cfg,
        senderId: "@owner:example.org",
        accountId: "ops",
        channel: "matrix",
        matchTarget: ({ target, normalizedSenderId }) => target.to === `user:${normalizedSenderId}`,
      }),
    ).toBe(true);

    expect(
      isChannelExecApprovalTargetRecipient({
        cfg,
        senderId: "@owner:example.org",
        accountId: "other",
        channel: "matrix",
        matchTarget: ({ target, normalizedSenderId }) => target.to === `user:${normalizedSenderId}`,
      }),
    ).toBe(false);
  });

  it("normalizes the requested channel id before matching targets", () => {
    const cfg: OpenClawConfig = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "matrix", to: "user:@owner:example.org" }],
        },
      },
    };

    expect(
      isChannelExecApprovalTargetRecipient({
        cfg,
        senderId: "@owner:example.org",
        channel: " Matrix ",
        matchTarget: ({ target, normalizedSenderId }) => target.to === `user:${normalizedSenderId}`,
      }),
    ).toBe(true);
  });
});

describe("createChannelExecApprovalProfile", () => {
  const profile = createChannelExecApprovalProfile({
    resolveConfig: () => ({
      enabled: true,
      target: "channel",
      agentFilter: ["ops"],
      sessionFilter: ["tail$"],
    }),
    resolveApprovers: () => ["owner"],
    isTargetRecipient: ({ senderId }) => senderId === "target",
    matchesRequestAccount: ({ accountId }) => accountId !== "other",
  });

  it("requires explicit enablement when approvers exist", () => {
    expect(
      isChannelExecApprovalClientEnabledFromConfig({
        approverCount: 1,
      }),
    ).toBe(false);
    expect(
      isChannelExecApprovalClientEnabledFromConfig({
        enabled: "auto",
        approverCount: 1,
      }),
    ).toBe(true);
    expect(
      isChannelExecApprovalClientEnabledFromConfig({
        enabled: true,
        approverCount: 1,
      }),
    ).toBe(true);
    expect(
      isChannelExecApprovalClientEnabledFromConfig({
        enabled: false,
        approverCount: 1,
      }),
    ).toBe(false);
    expect(
      isChannelExecApprovalClientEnabledFromConfig({
        approverCount: 0,
      }),
    ).toBe(false);
  });

  it("reuses shared client, auth, and request-filter logic", () => {
    expect(profile.isClientEnabled({ cfg: {} })).toBe(true);
    expect(profile.isApprover({ cfg: {}, senderId: "owner" })).toBe(true);
    expect(profile.isAuthorizedSender({ cfg: {}, senderId: "target" })).toBe(true);
    expect(profile.resolveTarget({ cfg: {} })).toBe("channel");

    expect(
      profile.shouldHandleRequest({
        cfg: {},
        accountId: "ops",
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            agentId: "ops",
            sessionKey: "agent:ops:telegram:direct:owner:tail",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(true);

    expect(
      profile.shouldHandleRequest({
        cfg: {},
        accountId: "other",
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            agentId: "ops",
            sessionKey: "agent:ops:telegram:direct:owner:tail",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(false);
  });

  it("supports local prompt suppression without requiring the client to be enabled", () => {
    const promptProfile = createChannelExecApprovalProfile({
      resolveConfig: () => undefined,
      resolveApprovers: () => [],
      requireClientEnabledForLocalPromptSuppression: false,
    });

    expect(
      promptProfile.shouldSuppressLocalPrompt({
        cfg: {},
        payload: {
          channelData: {
            execApproval: {
              approvalId: "req-1",
              approvalSlug: "req-1",
            },
          },
        },
      }),
    ).toBe(true);
  });
});
