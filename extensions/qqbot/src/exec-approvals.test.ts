// Qqbot tests cover exec approvals plugin behavior.
import { isImplicitSameChatApprovalAuthorization } from "openclaw/plugin-sdk/approval-auth-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPlatformAdapter, type PlatformAdapter } from "./engine/adapter/index.js";
import { authorizeQQBotApprovalAction } from "./exec-approvals.js";

describe("authorizeQQBotApprovalAction", () => {
  beforeEach(() => {
    registerPlatformAdapter({
      validateRemoteUrl: vi.fn(async () => undefined),
      resolveSecret: vi.fn(async (value: unknown) =>
        typeof value === "string" ? value : undefined,
      ),
      downloadFile: vi.fn(async () => "/tmp/file"),
      fetchMedia: vi.fn(async () => {
        throw new Error("unused");
      }),
      getTempDir: () => "/tmp",
      hasConfiguredSecret: (value: unknown) => typeof value === "string" && value.length > 0,
      normalizeSecretInputString: (value: unknown) =>
        typeof value === "string" ? value : undefined,
      resolveSecretInputString: ({ value }: { value: unknown }) =>
        typeof value === "string" ? value : undefined,
    } as PlatformAdapter);
  });

  it("marks unconfigured exec approval fallback authorization as implicit", () => {
    const result = authorizeQQBotApprovalAction({
      cfg: {
        channels: {
          qqbot: {
            appId: "app",
            clientSecret: "secret",
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      senderId: "ATTACKER_OPENID",
      approvalKind: "exec",
    });

    expect(result).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(result)).toBe(true);
  });

  it("keeps configured approver authorization explicit", () => {
    const result = authorizeQQBotApprovalAction({
      cfg: {
        channels: {
          qqbot: {
            appId: "app",
            clientSecret: "secret",
            execApprovals: {
              enabled: true,
              approvers: ["OWNER_OPENID"],
            },
          },
        },
      } as OpenClawConfig,
      accountId: "default",
      senderId: "OWNER_OPENID",
      approvalKind: "exec",
    });

    expect(result).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(result)).toBe(false);
  });
});
