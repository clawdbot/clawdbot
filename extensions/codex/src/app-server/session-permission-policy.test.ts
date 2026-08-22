import { describe, expect, it } from "vitest";
import type { CodexAppServerRuntimeOptions, CodexPluginConfig } from "./config.js";
import {
  applyCodexSessionPermissionPolicy,
  resolveCodexSessionPermissionCwd,
} from "./session-permission-policy.js";

const pluginConfig: CodexPluginConfig = {};

function appServer(): CodexAppServerRuntimeOptions {
  return {
    start: { transport: "stdio", command: "codex", args: ["app-server"], headers: {} },
    connectionClass: "local-loopback",
    remoteAppsSubstrate: "preconfigured",
    codeModeOnly: false,
    loopDetectionPreToolUseRelay: true,
    requestTimeoutMs: 60_000,
    turnCompletionIdleTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
  };
}

describe("Codex session permission policy", () => {
  it.each([
    {
      mode: "read-only" as const,
      sandbox: "read-only",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    },
    {
      mode: "guarded" as const,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    },
    {
      mode: "workspace" as const,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    },
    {
      mode: "full" as const,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    },
  ])("maps $mode to one complete app-server tuple", (expected) => {
    const resolved = applyCodexSessionPermissionPolicy({
      appServer: appServer(),
      permissionMode: expected.mode,
      sessionRoot: "/workspace/project",
      pluginConfig,
      canUseAutoReview: true,
    });

    expect(resolved).toMatchObject({
      sandbox: expected.sandbox,
      approvalPolicy: expected.approvalPolicy,
      approvalsReviewer: expected.approvalsReviewer,
      sessionRoot: "/workspace/project",
    });
  });

  it("downgrades workspace review to the user when model-backed review is untrusted", () => {
    expect(
      applyCodexSessionPermissionPolicy({
        appServer: appServer(),
        permissionMode: "workspace",
        sessionRoot: "/workspace/project",
        pluginConfig,
        canUseAutoReview: false,
      }).approvalsReviewer,
    ).toBe("user");
  });

  it("atomically downgrades a disallowed full tuple to guardian requirements", () => {
    const resolved = applyCodexSessionPermissionPolicy({
      appServer: appServer(),
      permissionMode: "full",
      sessionRoot: "/workspace/project",
      pluginConfig,
      canUseAutoReview: true,
      requirementsToml: [
        'allowed_sandbox_modes = ["workspace-write"]',
        'allowed_approval_policies = ["on-request"]',
        'allowed_approvals_reviewers = ["auto_review"]',
      ].join("\n"),
    });

    expect(resolved).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
  });

  it.each([
    {
      mode: "guarded" as const,
      policies: ["untrusted"],
      approvalsReviewer: "user",
    },
    {
      mode: "workspace" as const,
      policies: ["untrusted", "never"],
      approvalsReviewer: "auto_review",
    },
  ])("preserves managed prompting approval for a $mode session", (expected) => {
    const resolved = applyCodexSessionPermissionPolicy({
      appServer: appServer(),
      permissionMode: expected.mode,
      sessionRoot: "/workspace/project",
      pluginConfig,
      canUseAutoReview: true,
      requirementsToml: `allowed_approval_policies = [${expected.policies
        .map((policy) => `"${policy}"`)
        .join(", ")}]`,
    });

    expect(resolved).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
      approvalsReviewer: expected.approvalsReviewer,
    });
  });

  it.each([
    {
      mode: "read-only" as const,
      allowedSandbox: "workspace-write",
    },
    {
      mode: "read-only" as const,
      allowedSandbox: "danger-full-access",
    },
    {
      mode: "guarded" as const,
      allowedSandbox: "danger-full-access",
    },
    {
      mode: "workspace" as const,
      allowedSandbox: "danger-full-access",
    },
  ])("never widens $mode access to the managed $allowedSandbox sandbox", (params) => {
    expect(() =>
      applyCodexSessionPermissionPolicy({
        appServer: appServer(),
        permissionMode: params.mode,
        sessionRoot: "/workspace/project",
        pluginConfig,
        canUseAutoReview: true,
        requirementsToml: `allowed_sandbox_modes = ["${params.allowedSandbox}"]`,
      }),
    ).toThrow(
      `Codex session permission mode=${params.mode} cannot satisfy managed sandbox requirements`,
    );
  });

  it("lets managed requirements further restrict a guarded session to read-only", () => {
    expect(
      applyCodexSessionPermissionPolicy({
        appServer: appServer(),
        permissionMode: "guarded",
        sessionRoot: "/workspace/project",
        pluginConfig,
        canUseAutoReview: true,
        requirementsToml: 'allowed_sandbox_modes = ["read-only"]',
      }),
    ).toMatchObject({ sandbox: "read-only", approvalsReviewer: "user" });
  });

  it("lets a deny exec floor tighten a guarded tuple", () => {
    const resolved = applyCodexSessionPermissionPolicy({
      appServer: appServer(),
      permissionMode: "guarded",
      sessionRoot: "/workspace/project",
      pluginConfig,
      canUseAutoReview: true,
      execMode: "deny",
    });

    expect(resolved).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
  });

  it.each(["read-only", "guarded", "workspace"] as const)(
    "keeps mandatory per-command approval when applying %s session permissions",
    (permissionMode) => {
      expect(
        applyCodexSessionPermissionPolicy({
          appServer: { ...appServer(), approvalPolicy: "untrusted" },
          permissionMode,
          sessionRoot: "/workspace/project",
          pluginConfig,
          canUseAutoReview: true,
          execMode: "ask",
        }),
      ).toMatchObject({ approvalPolicy: "untrusted", approvalsReviewer: "user" });
    },
  );

  it("fails closed when session requirements exclude mandatory per-command approval", () => {
    expect(() =>
      applyCodexSessionPermissionPolicy({
        appServer: { ...appServer(), approvalPolicy: "untrusted" },
        permissionMode: "guarded",
        sessionRoot: "/workspace/project",
        pluginConfig,
        canUseAutoReview: true,
        execMode: "ask",
        requirementsToml: 'allowed_approval_policies = ["on-request"]',
      }),
    ).toThrow("tools.exec.ask=always requires Codex app-server per-command approvals");
  });

  it("fails closed when requirements cannot provide mandatory user review", () => {
    expect(() =>
      applyCodexSessionPermissionPolicy({
        appServer: appServer(),
        permissionMode: "guarded",
        sessionRoot: "/workspace/project",
        pluginConfig,
        canUseAutoReview: true,
        requirementsToml: [
          'allowed_sandbox_modes = ["workspace-write"]',
          'allowed_approval_policies = ["on-request"]',
          'allowed_approvals_reviewers = ["auto_review"]',
        ].join("\n"),
      }),
    ).toThrow("requires Codex app-server user approvals");
  });

  it("keeps a nested cwd and clamps an outside cwd to the prepared root", () => {
    expect(
      resolveCodexSessionPermissionCwd({
        permissionMode: "workspace",
        sessionRoot: "/workspace/project",
        requestedCwd: "/workspace/project/packages/app",
        fallbackCwd: "/workspace",
      }),
    ).toBe("/workspace/project/packages/app");
    expect(
      resolveCodexSessionPermissionCwd({
        permissionMode: "workspace",
        sessionRoot: "/workspace/project",
        requestedCwd: "/workspace/other",
        fallbackCwd: "/workspace",
      }),
    ).toBe("/workspace/project");
  });
});
