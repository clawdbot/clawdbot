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
  it("warns when auto resolves to gateway and host approvals clamp global full security", () => {
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

  it("does not warn when auto resolves to sandbox", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { exec: { host: "auto", security: "full" } },
        },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toBeUndefined();
  });

  it("does not warn when auto resolves to the main agent sandbox", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: {
          agents: { list: [{ id: "main", sandbox: { mode: "all" } }] },
          tools: { exec: { host: "auto", security: "full" } },
        },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toBeUndefined();
  });

  it("warns when only an unrelated agent sandbox owns auto exec", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: {
          agents: { list: [{ id: "ops", sandbox: { mode: "all" } }] },
          tools: { exec: { host: "auto", security: "full" } },
        },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toContain("tools.exec.security=full is clamped to allowlist");
  });

  it("warns when the main agent disables the default sandbox", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: {
          agents: {
            defaults: { sandbox: { mode: "all" } },
            list: [{ id: "main", sandbox: { mode: "off" } }],
          },
          tools: { exec: { host: "auto", security: "full" } },
        },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toContain("tools.exec.security=full is clamped to allowlist");
  });

  it("warns for auto when sandbox can only own non-main sessions", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: {
          agents: { defaults: { sandbox: { mode: "non-main" } } },
          tools: { exec: { host: "auto", security: "full" } },
        },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toContain("tools.exec.security=full is clamped to allowlist");
  });

  it("warns for auto when only an agent-level sandbox can own non-main sessions", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: {
          agents: { list: [{ id: "ops", sandbox: { mode: "non-main" } }] },
          tools: { exec: { host: "auto", security: "full" } },
        },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toContain("tools.exec.security=full is clamped to allowlist");
  });

  it("warns for explicit gateway even when sandbox is available", () => {
    expect(
      buildGlobalExecPolicyClampWarning({
        cfg: {
          agents: { defaults: { sandbox: { mode: "all" } } },
          tools: { exec: { host: "gateway", security: "full" } },
        },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: {
          version: 1,
          defaults: { security: "allowlist", ask: "off" },
          agents: {},
        },
      }),
    ).toContain("tools.exec.security=full is clamped to allowlist");
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

  it("uses approvals remediation when an agent approval clamps the global scope", () => {
    const warning = buildGlobalExecPolicyClampWarning({
      cfg: { tools: { exec: { security: "full" } } },
      approvalsPath: "/tmp/openclaw-exec-approvals.json",
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "off" },
        agents: { main: { security: "allowlist" } },
      },
    });

    expect(warning).toContain("agents.main.security");
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
