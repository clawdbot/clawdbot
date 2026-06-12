// Gateway exec policy startup warning tests cover read-only clamp diagnostics.
import { describe, expect, it, vi } from "vitest";

const execApprovalsMocks = vi.hoisted(() => ({
  readExecApprovalsSnapshot: vi.fn(),
}));

vi.mock("../../infra/exec-approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/exec-approvals.js")>();
  return {
    ...actual,
    readExecApprovalsSnapshot: execApprovalsMocks.readExecApprovalsSnapshot,
  };
});

import {
  buildCurrentGlobalExecPolicyClampWarning,
  buildGlobalExecPolicyClampWarning,
} from "./exec-policy-startup-warning.js";

describe("buildGlobalExecPolicyClampWarning", () => {
  it("warns when host approvals clamp global full security to allowlist", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: { tools: { exec: { security: "full" } } },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toBe(
      'tools.exec.security=full is clamped to allowlist by host approvals (/tmp/openclaw-exec-approvals.json defaults.security). Run "openclaw exec-policy set --security full" to synchronize host approvals, or "openclaw exec-policy show" for details.',
    );
  });

  it("warns when host approvals clamp global full security to deny", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: { tools: { exec: { security: "full" } } },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "deny", ask: "off" },
          agents: {},
        },
      }),
    ).toContain("tools.exec.security=full is clamped to deny");
  });

  it("uses approvals remediation for mode-based configs", () => {
    const warning = buildGlobalExecPolicyClampWarning({
      cfg: { tools: { exec: { mode: "full" } } },
      approvalsPath: "/tmp/openclaw-exec-approvals.json",
      approvals: {
        version: 1,
        defaults: { security: "allowlist", ask: "off" },
        agents: {},
      },
    });

    expect(warning).toContain("tools.exec.mode requests security=full is clamped to allowlist");
    expect(warning).toContain("openclaw approvals set --stdin");
    expect(warning).not.toContain("openclaw exec-policy set --security");
  });

  it("does not warn for node-managed global exec policy", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: { tools: { exec: { host: "node", security: "full" } } },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toBeUndefined();
  });

  it("does not warn for sandbox-managed global exec policy", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: { tools: { exec: { host: "sandbox", security: "full" } } },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toBeUndefined();
  });

  it("does not warn when requested security is already effective", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: { tools: { exec: { security: "allowlist" } } },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toBeUndefined();
  });

  it("does not fail startup when approvals snapshot loading fails", () => {
    execApprovalsMocks.readExecApprovalsSnapshot.mockImplementationOnce(() => {
      throw new Error("EISDIR");
    });

    expect(
      buildCurrentGlobalExecPolicyClampWarning({ tools: { exec: { security: "full" } } }),
    ).toBeUndefined();
  });
});
