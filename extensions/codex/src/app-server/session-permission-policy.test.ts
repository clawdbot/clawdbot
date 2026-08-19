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
      mode: "full" as const,
      execMode: "ask" as const,
      sandbox: "danger-full-access",
    },
    {
      mode: "guarded" as const,
      execMode: "deny" as const,
      sandbox: "read-only",
    },
  ])("lets effective $execMode exec floors tighten a $mode tuple", (expected) => {
    const resolved = applyCodexSessionPermissionPolicy({
      appServer: appServer(),
      permissionMode: expected.mode,
      sessionRoot: "/workspace/project",
      pluginConfig,
      canUseAutoReview: true,
      execMode: expected.execMode,
    });

    expect(resolved).toMatchObject({
      sandbox: expected.sandbox,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
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
