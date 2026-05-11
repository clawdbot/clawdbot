import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMatrixExecApprovalApprovers,
  isMatrixExecApprovalApprover,
  isMatrixExecApprovalAuthorizedSender,
  isMatrixExecApprovalClientEnabled,
  isMatrixExecApprovalTargetRecipient,
  normalizeMatrixApproverId,
  resolveMatrixExecApprovalTarget,
  shouldHandleMatrixExecApprovalRequest,
  shouldSuppressLocalMatrixExecApprovalPrompt,
} from "./exec-approvals.js";
import type { MatrixAccountConfig, MatrixExecApprovalConfig } from "./types.js";

const tempDirs: string[] = [];
type MatrixExecApprovalRequest = Parameters<
  typeof shouldHandleMatrixExecApprovalRequest
>[0]["request"];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-exec-approvals-"));
  tempDirs.push(dir);
  return dir;
}

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>["execApprovals"],
  channelOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>>,
): OpenClawConfig {
  return {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok",
        ...channelOverrides,
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

function matrixAccount(
  accountId: string,
  execApprovals: MatrixExecApprovalConfig,
  overrides: Partial<MatrixAccountConfig> = {},
): MatrixAccountConfig {
  return {
    homeserver: "https://matrix.example.org",
    userId: `@bot-${accountId}:example.org`,
    accessToken: `tok-${accountId}`,
    ...overrides,
    execApprovals,
  };
}

function buildMultiAccountMatrixConfig(params: {
  sessionStorePath?: string;
  defaultExecApprovals?: MatrixExecApprovalConfig;
  opsExecApprovals?: MatrixExecApprovalConfig;
  defaultOverrides?: Partial<MatrixAccountConfig>;
  opsOverrides?: Partial<MatrixAccountConfig>;
}): OpenClawConfig {
  return {
    ...(params.sessionStorePath ? { session: { store: params.sessionStorePath } } : {}),
    channels: {
      matrix: {
        accounts: {
          default: matrixAccount(
            "default",
            params.defaultExecApprovals ?? {
              enabled: true,
              approvers: ["@owner:example.org"],
            },
            params.defaultOverrides,
          ),
          ops: matrixAccount(
            "ops",
            params.opsExecApprovals ?? {
              enabled: true,
              approvers: ["@owner:example.org"],
            },
            params.opsOverrides,
          ),
        },
      },
    },
  } as OpenClawConfig;
}

function makeForeignChannelApprovalRequest(params: {
  id: string;
  sessionKey?: string;
  agentId?: string;
}): MatrixExecApprovalRequest {
  return {
    id: params.id,
    request: {
      command: "echo hi",
      agentId: params.agentId ?? "ops-agent",
      sessionKey: params.sessionKey ?? "agent:ops-agent:missing",
      turnSourceChannel: "slack",
      turnSourceTo: "channel:C123",
    },
    createdAtMs: 0,
    expiresAtMs: 1000,
  };
}

describe("matrix exec approvals", () => {
  it("requires enablement and approvers before enabling the client", () => {
    expect(isMatrixExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
    expect(
      isMatrixExecApprovalClientEnabled({
        cfg: buildConfig(undefined, { dm: { allowFrom: ["@owner:example.org"] } }),
      }),
    ).toBe(false);
    expect(isMatrixExecApprovalClientEnabled({ cfg: buildConfig({ enabled: true }) })).toBe(false);
    expect(
      isMatrixExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true }, { dm: { allowFrom: ["@owner:example.org"] } }),
      }),
    ).toBe(true);
    expect(
      isMatrixExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true, approvers: ["@owner:example.org"] }),
      }),
    ).toBe(true);
  });

  it("prefers explicit approvers when configured", () => {
    const cfg = buildConfig(
      { enabled: true, approvers: ["user:@override:example.org"] },
      { dm: { allowFrom: ["@owner:example.org"] } },
    );

    expect(getMatrixExecApprovalApprovers({ cfg })).toEqual(["@override:example.org"]);
    expect(isMatrixExecApprovalApprover({ cfg, senderId: "@override:example.org" })).toBe(true);
    expect(isMatrixExecApprovalApprover({ cfg, senderId: "@owner:example.org" })).toBe(false);
  });

  it("ignores wildcard allowlist entries when inferring exec approvers", () => {
    const cfg = buildConfig({ enabled: true }, { dm: { allowFrom: ["*"] } });

    expect(getMatrixExecApprovalApprovers({ cfg })).toStrictEqual([]);
    expect(isMatrixExecApprovalClientEnabled({ cfg })).toBe(false);
  });

  it("defaults target to dm", () => {
    expect(
      resolveMatrixExecApprovalTarget({
        cfg: buildConfig({ enabled: true, approvers: ["@owner:example.org"] }),
      }),
    ).toBe("dm");
  });

  it("matches matrix target recipients from generic approval forwarding targets", () => {
    const cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok",
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [
            { channel: "matrix", to: "user:@target:example.org" },
            { channel: "matrix", to: "room:!ops:example.org" },
          ],
        },
      },
    } as OpenClawConfig;

    expect(isMatrixExecApprovalTargetRecipient({ cfg, senderId: "@target:example.org" })).toBe(
      true,
    );
    expect(isMatrixExecApprovalTargetRecipient({ cfg, senderId: "@other:example.org" })).toBe(
      false,
    );
    expect(isMatrixExecApprovalAuthorizedSender({ cfg, senderId: "@target:example.org" })).toBe(
      true,
    );
  });

  it("suppresses local prompts only when the native client is enabled", () => {
    const payload = {
      channelData: {
        execApproval: {
          approvalId: "req-1",
          approvalSlug: "req-1",
          agentId: "ops-agent",
          sessionKey: "agent:ops-agent:matrix:channel:!ops:example.org",
        },
      },
    };

    expect(
      shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg: buildConfig({ enabled: true, approvers: ["@owner:example.org"] }),
        payload,
      }),
    ).toBe(true);

    expect(
      shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg: buildConfig(),
        payload,
      }),
    ).toBe(false);
  });

  it("keeps local prompts when filters exclude the request", () => {
    const payload = {
      channelData: {
        execApproval: {
          approvalId: "req-1",
          approvalSlug: "req-1",
          agentId: "other-agent",
          sessionKey: "agent:other-agent:matrix:channel:!ops:example.org",
        },
      },
    };

    expect(
      shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg: buildConfig({
          enabled: true,
          approvers: ["@owner:example.org"],
          agentFilter: ["ops-agent"],
        }),
        payload,
      }),
    ).toBe(false);
  });

  it("suppresses local prompts for generic exec payloads when metadata matches filters", () => {
    const payload = {
      channelData: {
        execApproval: {
          approvalId: "req-1",
          approvalSlug: "req-1",
          approvalKind: "exec",
          agentId: "ops-agent",
          sessionKey: "agent:ops-agent:matrix:channel:!ops:example.org",
        },
      },
    };

    expect(
      shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg: buildConfig({
          enabled: true,
          approvers: ["@owner:example.org"],
          agentFilter: ["ops-agent"],
          sessionFilter: ["matrix:channel:"],
        }),
        payload,
      }),
    ).toBe(true);
  });

  it("suppresses local prompts for plugin approval payloads when DM approvers are configured", () => {
    const payload = {
      channelData: {
        execApproval: {
          approvalId: "plugin:req-1",
          approvalSlug: "plugin:r",
          approvalKind: "plugin",
        },
      },
    };

    expect(
      shouldSuppressLocalMatrixExecApprovalPrompt({
        cfg: buildConfig(
          { enabled: true, approvers: ["@owner:example.org"] },
          { dm: { allowFrom: ["@owner:example.org"] } },
        ),
        payload,
      }),
    ).toBe(true);
  });

  it("normalizes prefixed approver ids", () => {
    expect(normalizeMatrixApproverId("matrix:@owner:example.org")).toBe("@owner:example.org");
    expect(normalizeMatrixApproverId("user:@owner:example.org")).toBe("@owner:example.org");
  });

  it("applies agent and session filters to request handling", () => {
    const cfg = buildConfig({
      enabled: true,
      approvers: ["@owner:example.org"],
      agentFilter: ["ops-agent"],
      sessionFilter: ["matrix:channel:", "ops$"],
    });

    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        request: {
          id: "req-1",
          request: {
            command: "echo hi",
            agentId: "ops-agent",
            sessionKey: "agent:ops-agent:matrix:channel:!room:example.org:ops",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(true);

    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        request: {
          id: "req-2",
          request: {
            command: "echo hi",
            agentId: "other-agent",
            sessionKey: "agent:other-agent:matrix:channel:!room:example.org:ops",
          },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toBe(false);
  });

  it("scopes non-matrix turn sources to the stored matrix account", () => {
    const tmpDir = createTempDir();
    const storePath = path.join(tmpDir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:ops-agent:matrix:channel:!room:example.org": {
          sessionId: "main",
          updatedAt: 1,
          origin: {
            provider: "matrix",
            accountId: "ops",
          },
          lastChannel: "slack",
          lastTo: "channel:C999",
          lastAccountId: "work",
        },
      }),
      "utf-8",
    );
    const cfg = buildMultiAccountMatrixConfig({ sessionStorePath: storePath });
    const request = makeForeignChannelApprovalRequest({
      id: "req-3",
      sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
    });

    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(false);
    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(true);
  });

  it("rejects unbound foreign-channel approvals in multi-account matrix configs", () => {
    const cfg = buildMultiAccountMatrixConfig({});
    const request = makeForeignChannelApprovalRequest({ id: "req-4" });

    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(false);
    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(false);
  });

  it("allows unbound foreign-channel approvals when only one matrix account can handle them", () => {
    const cfg = buildMultiAccountMatrixConfig({
      opsExecApprovals: {
        enabled: false,
        approvers: ["@owner:example.org"],
      },
    });
    const request = makeForeignChannelApprovalRequest({ id: "req-5" });

    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(false);
  });

  it("uses request filters when checking foreign-channel matrix ambiguity", () => {
    const cfg = buildMultiAccountMatrixConfig({
      defaultExecApprovals: {
        enabled: true,
        approvers: ["@owner:example.org"],
        agentFilter: ["ops-agent"],
      },
      opsExecApprovals: {
        enabled: true,
        approvers: ["@owner:example.org"],
        agentFilter: ["other-agent"],
      },
    });
    const request = makeForeignChannelApprovalRequest({ id: "req-6" });

    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(false);
  });

  it("ignores disabled matrix accounts when checking foreign-channel ambiguity", () => {
    const cfg = buildMultiAccountMatrixConfig({
      opsOverrides: { enabled: false },
    });
    const request = makeForeignChannelApprovalRequest({ id: "req-7" });

    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "default",
        request,
      }),
    ).toBe(true);
    expect(
      shouldHandleMatrixExecApprovalRequest({
        cfg,
        accountId: "ops",
        request,
      }),
    ).toBe(false);
  });
});
