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

import { buildCurrentGlobalExecPolicyClampWarning } from "./exec-policy-startup-warning.js";

/**
 * Drives the startup warning through its only production entry point, feeding
 * approvals via the same snapshot reader gateway startup uses.
 */
function clampWarningFor(params: {
  cfg: Parameters<typeof buildCurrentGlobalExecPolicyClampWarning>[0];
  approvals: unknown;
  approvalsPath?: string;
}): string | undefined {
  execApprovalsMocks.readExecApprovalsSnapshot.mockReturnValue({
    file: params.approvals,
    path: params.approvalsPath,
  });
  return buildCurrentGlobalExecPolicyClampWarning(params.cfg);
}

describe("global exec policy clamp startup warning", () => {
  it("warns when auto resolves to gateway and host approvals clamp global full security", () => {
    expect(
      clampWarningFor({
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
      clampWarningFor({
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
      clampWarningFor({
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

  it("does not warn when auto resolves to a configured default agent sandbox", () => {
    expect(
      clampWarningFor({
        cfg: {
          agents: { list: [{ id: "ops", default: true, sandbox: { mode: "all" } }] },
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
      clampWarningFor({
        cfg: {
          agents: { list: [{ id: "main" }, { id: "ops", sandbox: { mode: "all" } }] },
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
      clampWarningFor({
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
      clampWarningFor({
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
      clampWarningFor({
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
      clampWarningFor({
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
      clampWarningFor({
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

  it("uses diagnostic guidance for mode-based configs", () => {
    const warning = clampWarningFor({
      cfg: { tools: { exec: { mode: "full" } } },
      approvalsPath: "/tmp/openclaw-exec-approvals.json",
      approvals: {
        version: 1,
        defaults: { security: "allowlist", ask: "off" },
        agents: {},
      },
    });

    expect(warning).toContain("tools.exec.mode requests security=full is clamped to allowlist");
    expect(warning).toContain('Run "openclaw exec-policy show" to inspect the clamping scope.');
    expect(warning).toContain("https://docs.openclaw.ai/tools/exec-approvals");
    expect(warning).not.toContain("openclaw approvals set --stdin");
    expect(warning).not.toContain("openclaw exec-policy set --security");
  });

  it("uses diagnostic guidance when an agent approval clamps the global scope", () => {
    const warning = clampWarningFor({
      cfg: { tools: { exec: { security: "full" } } },
      approvalsPath: "/tmp/openclaw-exec-approvals.json",
      approvals: {
        version: 1,
        defaults: { security: "full", ask: "off" },
        agents: { main: { security: "allowlist" } },
      },
    });

    expect(warning).toContain("agents.main.security");
    expect(warning).toContain('Run "openclaw exec-policy show" to inspect the clamping scope.');
    expect(warning).toContain("https://docs.openclaw.ai/tools/exec-approvals");
    expect(warning).not.toContain("openclaw approvals set --stdin");
    expect(warning).not.toContain("openclaw exec-policy set --security");
  });

  it("does not warn for node-managed global exec policy", () => {
    expect(
      clampWarningFor({
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
      clampWarningFor({
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

  it("does not warn when host approvals have no policy overrides", () => {
    expect(
      clampWarningFor({
        cfg: { tools: { exec: { security: "full" } } },
        approvalsPath: "/tmp/openclaw-exec-approvals.json",
        approvals: { version: 1, agents: {} },
      }),
    ).toBeUndefined();
  });

  it("does not warn when requested security is already effective", () => {
    expect(
      clampWarningFor({
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
