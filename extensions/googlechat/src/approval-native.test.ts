import type { ChannelOutboundPayloadHint } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it } from "vitest";
import {
  googleChatApprovalCapability,
  shouldHandleGoogleChatNativeApprovalRequest,
  shouldSuppressLocalGoogleChatExecApprovalPrompt,
} from "./approval-native.js";

const GOOGLE_CHAT_APPROVAL_ACCOUNT = {
  serviceAccount: {
    type: "service_account" as const,
    client_email: "bot@example.com",
    private_key: "test-key",
    token_uri: "https://oauth2.googleapis.com/token",
  },
  audienceType: "app-url" as const,
  audience: "https://chat-app.example.test/googlechat",
  appPrincipal: "123456789012345678901",
  allowFrom: ["users/123"],
};

const execApprovalPayload: ReplyPayload = {
  text: "I need approval to run this command.",
  channelData: {
    execApproval: {
      approvalId: "12345678-1234-1234-1234-123456789012",
      approvalSlug: "12345678",
      approvalKind: "exec",
      agentId: "dev",
      sessionKey: "agent:dev:main",
    },
  },
};

const activeExecApprovalHint: ChannelOutboundPayloadHint = {
  kind: "approval-pending",
  approvalKind: "exec",
  nativeRouteActive: true,
};

describe("googleChatApprovalCapability", () => {
  it("declares native exec and plugin approval runtime support", async () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    expect(runtime?.eventKinds).toEqual(["exec", "plugin"]);
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          approvals: { exec: { enabled: true } },
          channels: {
            googlechat: {
              serviceAccount: {
                type: "service_account",
                client_email: "bot@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "app-url",
              audience: "https://chat-app.example.test/googlechat",
              appPrincipal: "123456789012345678901",
              allowFrom: ["users/123"],
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("does not enable native cards when webhook callback audience auth is incomplete", async () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          approvals: { exec: { enabled: true } },
          channels: {
            googlechat: {
              serviceAccount: {
                type: "service_account",
                client_email: "bot@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              allowFrom: ["users/123"],
            },
          },
        },
      }),
    ).toBe(false);
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          approvals: { exec: { enabled: true } },
          channels: {
            googlechat: {
              serviceAccount: {
                type: "service_account",
                client_email: "bot@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "project-number",
              allowFrom: ["users/123"],
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("requires a top-level approval forwarding route before enabling native cards", async () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    const googlechat = {
      serviceAccount: {
        type: "service_account" as const,
        client_email: "bot@example.com",
        private_key: "test-key",
        token_uri: "https://oauth2.googleapis.com/token",
      },
      audienceType: "app-url" as const,
      audience: "https://chat-app.example.test/googlechat",
      allowFrom: ["users/123"],
    };

    expect(
      runtime?.availability.isConfigured({
        cfg: { channels: { googlechat } },
      }),
    ).toBe(false);
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          approvals: { exec: { enabled: false } },
          channels: { googlechat },
        },
      }),
    ).toBe(false);
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          approvals: { exec: { enabled: true, mode: "targets" } },
          channels: { googlechat },
        },
      }),
    ).toBe(false);
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          approvals: { plugin: { enabled: true } },
          channels: { googlechat },
        },
      }),
    ).toBe(true);
  });

  it("enables native cards for supported webhook audience modes", async () => {
    const runtime = googleChatApprovalCapability.nativeRuntime;
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          approvals: { exec: { enabled: true } },
          channels: {
            googlechat: {
              serviceAccount: {
                type: "service_account",
                client_email: "bot@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "app-url",
              audience: "https://chat-app.example.test/googlechat",
              allowFrom: ["users/123"],
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      runtime?.availability.isConfigured({
        cfg: {
          approvals: { exec: { enabled: true } },
          channels: {
            googlechat: {
              serviceAccount: {
                type: "service_account",
                client_email: "bot@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "project-number",
              audience: "1234567890",
              allowFrom: ["users/123"],
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("preserves Google Chat approval actor authorization", () => {
    expect(
      googleChatApprovalCapability.authorizeActorAction?.({
        cfg: { channels: { googlechat: { allowFrom: ["users/123"] } } },
        senderId: "users/123",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      googleChatApprovalCapability.authorizeActorAction?.({
        cfg: { channels: { googlechat: { allowFrom: ["users/123"] } } },
        senderId: "users/999",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Google Chat.",
    });
  });

  it("only handles approvals for the originating Google Chat account", () => {
    const cfg: OpenClawConfig = {
      approvals: { exec: { enabled: true } },
      channels: {
        googlechat: {
          accounts: {
            alpha: {
              enabled: true,
              serviceAccount: {
                type: "service_account",
                client_email: "alpha@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "app-url",
              audience: "https://alpha.example.com/googlechat",
              appPrincipal: "123456789012345678901",
              allowFrom: ["users/123"],
            },
            beta: {
              enabled: true,
              serviceAccount: {
                type: "service_account",
                client_email: "beta@example.com",
                private_key: "test-key",
                token_uri: "https://oauth2.googleapis.com/token",
              },
              audienceType: "app-url",
              audience: "https://beta.example.com/googlechat",
              appPrincipal: "987654321098765432109",
              allowFrom: ["users/456"],
            },
          },
        },
      },
    };
    const request = {
      id: "approval-1",
      request: {
        command: "echo hi",
        turnSourceChannel: "googlechat",
        turnSourceAccountId: "alpha",
        turnSourceTo: "spaces/AAA",
      },
    } as never;

    expect(
      shouldHandleGoogleChatNativeApprovalRequest({
        cfg,
        accountId: "alpha",
        approvalKind: "exec",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleGoogleChatNativeApprovalRequest({
        cfg,
        accountId: "beta",
        approvalKind: "exec",
        request,
      }),
    ).toBe(false);
  });

  it("does not handle exec approvals when only plugin approval forwarding is enabled", () => {
    const cfg: OpenClawConfig = {
      approvals: { plugin: { enabled: true } },
      channels: {
        googlechat: {
          serviceAccount: {
            type: "service_account",
            client_email: "bot@example.com",
            private_key: "test-key",
            token_uri: "https://oauth2.googleapis.com/token",
          },
          audienceType: "app-url",
          audience: "https://chat-app.example.test/googlechat",
          appPrincipal: "123456789012345678901",
          allowFrom: ["users/123"],
        },
      },
    };
    const request = {
      id: "approval-1",
      request: {
        command: "echo hi",
        turnSourceChannel: "googlechat",
        turnSourceTo: "spaces/AAA",
      },
    } as never;

    expect(
      shouldHandleGoogleChatNativeApprovalRequest({
        cfg,
        approvalKind: "exec",
        request,
      }),
    ).toBe(false);
  });

  it("suppresses the local exec prompt when a Google Chat native route is active", () => {
    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        cfg: {
          approvals: { exec: { enabled: true } },
          channels: { googlechat: GOOGLE_CHAT_APPROVAL_ACCOUNT },
        },
        payload: execApprovalPayload,
        hint: activeExecApprovalHint,
      }),
    ).toBe(true);
  });

  it("keeps the local exec prompt when native Google Chat delivery cannot own it", () => {
    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        cfg: {
          approvals: { exec: { enabled: true } },
          channels: { googlechat: GOOGLE_CHAT_APPROVAL_ACCOUNT },
        },
        payload: execApprovalPayload,
        hint: {
          kind: "approval-pending",
          approvalKind: "exec",
          nativeRouteActive: false,
        },
      }),
    ).toBe(false);

    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        cfg: {
          approvals: { exec: { enabled: false } },
          channels: { googlechat: GOOGLE_CHAT_APPROVAL_ACCOUNT },
        },
        payload: execApprovalPayload,
        hint: activeExecApprovalHint,
      }),
    ).toBe(false);

    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        cfg: {
          approvals: { exec: { enabled: true } },
          channels: {
            googlechat: {
              ...GOOGLE_CHAT_APPROVAL_ACCOUNT,
              audience: undefined,
            },
          },
        },
        payload: execApprovalPayload,
        hint: activeExecApprovalHint,
      }),
    ).toBe(false);

    expect(
      shouldSuppressLocalGoogleChatExecApprovalPrompt({
        cfg: {
          approvals: { exec: { enabled: true } },
          channels: { googlechat: GOOGLE_CHAT_APPROVAL_ACCOUNT },
        },
        payload: {
          channelData: {
            execApproval: {
              approvalId: "12345678-1234-1234-1234-123456789012",
              approvalSlug: "12345678",
              approvalKind: "plugin",
            },
          },
        },
        hint: {
          kind: "approval-pending",
          approvalKind: "plugin",
          nativeRouteActive: true,
        },
      }),
    ).toBe(false);
  });
});
