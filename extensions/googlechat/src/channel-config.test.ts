// Googlechat tests cover channel config plugin behavior.
import type { ChannelOutboundPayloadHint } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearGoogleChatApprovalCardBindingsForTest,
  registerGoogleChatApprovalCardBinding,
} from "./approval-card-actions.js";
import { googlechatPlugin } from "./channel.js";
import { googlechatSetupPlugin } from "./channel.setup.js";

describe("googlechatPlugin config adapter", () => {
  beforeEach(() => {
    clearGoogleChatApprovalCardBindingsForTest();
  });

  it("keeps setup metadata aligned with the runtime plugin", () => {
    expect(googlechatSetupPlugin.id).toBe(googlechatPlugin.id);
    expect(googlechatSetupPlugin.meta).toEqual(googlechatPlugin.meta);
    expect(googlechatSetupPlugin.capabilities?.chatTypes).toEqual(
      googlechatPlugin.capabilities?.chatTypes,
    );
    expect(googlechatPlugin.capabilities?.media).toBe(true);
    expect(googlechatPlugin.capabilities?.reactions).toBeUndefined();
  });

  it("does not advertise user-auth-only actions", () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          actions: { reactions: true },
        },
      },
    } as OpenClawConfig;

    expect(googlechatPlugin.actions?.describeMessageTool?.({ cfg })).toEqual({
      actions: ["send"],
    });
    expect(googlechatPlugin.actions?.supportsAction?.({ action: "send" })).toBe(true);
    expect(googlechatPlugin.actions?.supportsAction?.({ action: "upload-file" })).toBe(false);
  });

  it("registers an exec-capable native approval runtime", () => {
    expect(googlechatPlugin.approvalCapability?.nativeRuntime?.eventKinds).toContain("exec");
  });

  it("keeps read-only accessors from resolving service account SecretRefs", () => {
    const cfg = {
      secrets: {
        providers: {
          google_chat_service_account: {
            source: "file",
            path: "/tmp/openclaw-missing-google-chat-service-account",
            mode: "singleValue",
          },
        },
      },
      channels: {
        googlechat: {
          serviceAccount: {
            source: "file",
            provider: "google_chat_service_account",
            id: "value",
          },
          dm: {
            allowFrom: ["users/123"],
          },
          defaultTo: "spaces/AAA",
        },
      },
    } as OpenClawConfig;

    expect(googlechatPlugin.config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
      "users/123",
    ]);
    expect(googlechatPlugin.config.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe(
      "spaces/AAA",
    );
  });

  it("wires native exec approval suppression through the outbound adapter", () => {
    const cfg = {
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
          dm: { allowFrom: ["users/123"] },
        },
      },
    } as OpenClawConfig;
    const payload: ReplyPayload = {
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
    const hint: ChannelOutboundPayloadHint = {
      kind: "approval-pending",
      approvalKind: "exec",
      nativeRouteActive: true,
    };

    expect(
      googlechatPlugin.outbound?.shouldSuppressLocalPayloadPrompt?.({
        cfg,
        payload,
        hint,
      }),
    ).toBe(true);
  });

  it("drops duplicate manual exec approval follow-up text after a native card is registered", () => {
    const approvalId = "12345678-1234-1234-1234-123456789012";
    registerGoogleChatApprovalCardBinding({
      token: "token-1",
      accountId: "default",
      approvalId,
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });
    const payload: ReplyPayload = {
      text: `I need approval.\nReply with:\n/approve ${approvalId.slice(0, 8)} allow-once`,
    };

    expect(
      googlechatPlugin.outbound?.normalizePayload?.({
        cfg: {} as OpenClawConfig,
        payload,
      }),
    ).toBeNull();
  });

  it("keeps unrelated or sendable structured approval-looking payloads visible", () => {
    const approvalId = "12345678-1234-1234-1234-123456789012";
    registerGoogleChatApprovalCardBinding({
      token: "token-1",
      accountId: "default",
      approvalId,
      approvalKind: "exec",
      decision: "allow-once",
      allowedDecisions: ["allow-once", "deny"],
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      expiresAtMs: Date.now() + 60_000,
    });
    const unrelatedPayload: ReplyPayload = { text: "/approve deadbeef allow-once" };
    const metadataPayload: ReplyPayload = {
      text: `/approve ${approvalId.slice(0, 8)} allow-once`,
      channelData: { execApproval: { approvalId } },
    };
    const structuredPayload: ReplyPayload = {
      text: `/approve ${approvalId.slice(0, 8)} allow-once`,
      presentation: { blocks: [] },
    };

    expect(
      googlechatPlugin.outbound?.normalizePayload?.({
        cfg: {} as OpenClawConfig,
        payload: unrelatedPayload,
      }),
    ).toBe(unrelatedPayload);
    expect(
      googlechatPlugin.outbound?.normalizePayload?.({
        cfg: {} as OpenClawConfig,
        payload: metadataPayload,
      }),
    ).toBeNull();
    expect(
      googlechatPlugin.outbound?.normalizePayload?.({
        cfg: {} as OpenClawConfig,
        payload: structuredPayload,
      }),
    ).toBe(structuredPayload);
  });
});
