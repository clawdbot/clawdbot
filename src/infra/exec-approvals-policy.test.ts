import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  collectExecPolicyScopeSnapshots,
  resolveExecPolicyScopeSummary,
} from "./exec-approvals-effective.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import {
  evaluateExecAllowlist,
  hasDurableExecApproval,
  maxAsk,
  minSecurity,
  type ExecApprovalsFile,
  normalizeExecAsk,
  normalizeExecHost,
  normalizeExecTarget,
  normalizeExecSecurity,
  requiresExecApproval,
} from "./exec-approvals.js";

function expectMalformedAgentAskUsesDefaults(agentAsk: unknown): void {
  const approvals = {
    version: 1,
    defaults: {
      ask: "always",
    },
    agents: {
      runner: {
        ask: agentAsk,
      },
    },
  } as unknown as ExecApprovalsFile;
  const summary = resolveExecPolicyScopeSummary({
    approvals,
    globalExecConfig: {
      ask: "off",
    },
    configPath: "agents.list.runner.tools.exec",
    scopeLabel: "agent:runner",
    agentId: "runner",
  });

  expect(summary.ask).toMatchObject({
    requested: "off",
    host: "always",
    hostSource: "~/.openclaw/exec-approvals.json defaults.ask",
    effective: "always",
    note: "more aggressive ask wins",
  });
}

describe("exec approvals policy helpers", () => {
  it.each([
    { raw: " gateway ", expected: "gateway" },
    { raw: "NODE", expected: "node" },
    { raw: "", expected: null },
    { raw: "ssh", expected: null },
  ])("normalizes exec host value %j", ({ raw, expected }) => {
    expect(normalizeExecHost(raw)).toBe(expected);
  });

  it.each([
    { raw: " auto ", expected: "auto" },
    { raw: " gateway ", expected: "gateway" },
    { raw: "NODE", expected: "node" },
    { raw: "", expected: null },
    { raw: "ssh", expected: null },
  ])("normalizes exec target value %j", ({ raw, expected }) => {
    expect(normalizeExecTarget(raw)).toBe(expected);
  });

  it.each([
    { raw: " allowlist ", expected: "allowlist" },
    { raw: "FULL", expected: "full" },
    { raw: "unknown", expected: null },
  ])("normalizes exec security value %j", ({ raw, expected }) => {
    expect(normalizeExecSecurity(raw)).toBe(expected);
  });

  it.each([
    { raw: " on-miss ", expected: "on-miss" },
    { raw: "ALWAYS", expected: "always" },
    { raw: "maybe", expected: null },
  ])("normalizes exec ask value %j", ({ raw, expected }) => {
    expect(normalizeExecAsk(raw)).toBe(expected);
  });

  it.each([
    { left: "deny" as const, right: "full" as const, expected: "deny" as const },
    {
      left: "allowlist" as const,
      right: "full" as const,
      expected: "allowlist" as const,
    },
    {
      left: "full" as const,
      right: "allowlist" as const,
      expected: "allowlist" as const,
    },
  ])("minSecurity picks the more restrictive value for %j", ({ left, right, expected }) => {
    expect(minSecurity(left, right)).toBe(expected);
  });

  it.each([
    { left: "off" as const, right: "always" as const, expected: "always" as const },
    { left: "on-miss" as const, right: "off" as const, expected: "on-miss" as const },
    { left: "always" as const, right: "on-miss" as const, expected: "always" as const },
  ])("maxAsk picks the more aggressive ask mode for %j", ({ left, right, expected }) => {
    expect(maxAsk(left, right)).toBe(expected);
  });

  it.each([
    {
      ask: "always" as const,
      security: "allowlist" as const,
      analysisOk: true,
      allowlistSatisfied: true,
      expected: true,
    },
    {
      ask: "always" as const,
      security: "full" as const,
      analysisOk: true,
      allowlistSatisfied: false,
      durableApprovalSatisfied: true,
      expected: true,
    },
    {
      ask: "off" as const,
      security: "allowlist" as const,
      analysisOk: true,
      allowlistSatisfied: false,
      expected: false,
    },
    {
      ask: "on-miss" as const,
      security: "allowlist" as const,
      analysisOk: true,
      allowlistSatisfied: true,
      expected: false,
    },
    {
      ask: "on-miss" as const,
      security: "allowlist" as const,
      analysisOk: false,
      allowlistSatisfied: false,
      expected: true,
    },
    {
      ask: "on-miss" as const,
      security: "full" as const,
      analysisOk: false,
      allowlistSatisfied: false,
      expected: false,
    },
  ])("requiresExecApproval respects ask mode and allowlist satisfaction for %j", (testCase) => {
    expect(requiresExecApproval(testCase)).toBe(testCase.expected);
  });

  it("treats exact-command allow-always approvals as durable trust", () => {
    expect(
      hasDurableExecApproval({
        analysisOk: false,
        segmentAllowlistEntries: [],
        allowlist: [
          {
            pattern: "=command:613b5a60181648fd",
            source: "allow-always",
          },
        ],
        commandText: 'powershell -NoProfile -Command "Write-Output hi"',
      }),
    ).toBe(true);
  });

  it("treats fully allow-always-matched segments as durable trust", () => {
    expect(
      hasDurableExecApproval({
        analysisOk: true,
        segmentAllowlistEntries: [
          { pattern: "/usr/bin/echo", source: "allow-always" },
          { pattern: "/usr/bin/printf", source: "allow-always" },
        ],
        allowlist: [],
      }),
    ).toBe(true);
  });

  it("marks policy-blocked segments as non-durable allowlist entries", () => {
    const executable = makeMockExecutableResolution({
      rawExecutable: "/usr/bin/echo",
      resolvedPath: "/usr/bin/echo",
      executableName: "echo",
    });
    const result = evaluateExecAllowlist({
      analysis: {
        ok: true,
        segments: [
          {
            raw: "/usr/bin/echo ok",
            argv: ["/usr/bin/echo", "ok"],
            resolution: makeMockCommandResolution({
              execution: executable,
            }),
          },
          {
            raw: "/bin/sh -lc whoami",
            argv: ["/bin/sh", "-lc", "whoami"],
            resolution: makeMockCommandResolution({
              execution: makeMockExecutableResolution({
                rawExecutable: "/bin/sh",
                resolvedPath: "/bin/sh",
                executableName: "sh",
              }),
              policyBlocked: true,
            }),
          },
        ],
      },
      allowlist: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      safeBins: new Set(),
      cwd: "/tmp",
      platform: process.platform,
    });

    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentAllowlistEntries).toEqual([
      expect.objectContaining({ pattern: "/usr/bin/echo" }),
      null,
    ]);
    expect(
      hasDurableExecApproval({
        analysisOk: true,
        segmentAllowlistEntries: result.segmentAllowlistEntries,
        allowlist: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      }),
    ).toBe(false);
  });

  it("explains stricter host security and ask precedence", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        version: 1,
        defaults: {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
        },
      },
      scopeExecConfig: {
        security: "full",
        ask: "off",
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expect(summary.security).toMatchObject({
      requested: "full",
      host: "allowlist",
      effective: "allowlist",
      hostSource: "~/.openclaw/exec-approvals.json defaults.security",
      note: "stricter host security wins",
    });
    expect(summary.ask).toMatchObject({
      requested: "off",
      host: "always",
      effective: "always",
      hostSource: "~/.openclaw/exec-approvals.json defaults.ask",
      note: "more aggressive ask wins",
    });
    expect(summary.askFallback).toEqual({
      effective: "deny",
      source: "~/.openclaw/exec-approvals.json defaults.askFallback",
    });
  });

  it("uses the actual approvals path when reporting host sources", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        version: 1,
        defaults: {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
        },
      },
      scopeExecConfig: {
        security: "full",
        ask: "off",
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
      hostPath: "/tmp/node-exec-approvals.json",
    });

    expect(summary.security.hostSource).toBe("/tmp/node-exec-approvals.json defaults.security");
    expect(summary.ask.hostSource).toBe("/tmp/node-exec-approvals.json defaults.ask");
    expect(summary.askFallback).toEqual({
      effective: "deny",
      source: "/tmp/node-exec-approvals.json defaults.askFallback",
    });
  });

  it("does not let host ask=off suppress a stricter requested ask", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        version: 1,
        defaults: {
          ask: "off",
        },
      },
      scopeExecConfig: {
        ask: "always",
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expect(summary.ask).toMatchObject({
      requested: "always",
      host: "off",
      effective: "always",
      note: "requested ask applies",
    });
  });

  it("clamps askFallback to the effective security", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        version: 1,
        defaults: {
          security: "full",
          ask: "always",
          askFallback: "full",
        },
      },
      scopeExecConfig: {
        security: "allowlist",
        ask: "always",
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expect(summary.askFallback).toEqual({
      effective: "allowlist",
      source: "~/.openclaw/exec-approvals.json defaults.askFallback",
    });
  });

  it("skips malformed host fields when attributing their source", () => {
    expectMalformedAgentAskUsesDefaults("foo");
  });

  it("ignores malformed non-string host fields when attributing their source", () => {
    expectMalformedAgentAskUsesDefaults(true);
  });

  it("does not credit mixed-case host fields that resolution ignores", () => {
    expectMalformedAgentAskUsesDefaults("Always");
  });

  it("attributes host policy to wildcard agent entries before defaults", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        version: 1,
        defaults: {
          security: "full",
          ask: "off",
          askFallback: "full",
        },
        agents: {
          "*": {
            security: "allowlist",
            ask: "always",
            askFallback: "deny",
          },
        },
      },
      scopeExecConfig: {
        security: "full",
        ask: "off",
      },
      configPath: "agents.list.runner.tools.exec",
      scopeLabel: "agent:runner",
      agentId: "runner",
    });

    expect(summary.security).toMatchObject({
      host: "allowlist",
      hostSource: "~/.openclaw/exec-approvals.json agents.*.security",
    });
    expect(summary.ask).toMatchObject({
      host: "always",
      hostSource: "~/.openclaw/exec-approvals.json agents.*.ask",
    });
    expect(summary.askFallback).toEqual({
      effective: "deny",
      source: "~/.openclaw/exec-approvals.json agents.*.askFallback",
    });
  });

  it("inherits requested agent policy from global tools.exec config", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        version: 1,
        agents: {
          runner: {
            security: "allowlist",
            ask: "always",
          },
        },
      },
      globalExecConfig: {
        security: "full",
        ask: "off",
      },
      configPath: "agents.list.runner.tools.exec",
      scopeLabel: "agent:runner",
      agentId: "runner",
    });

    expect(summary.security).toMatchObject({
      requested: "full",
      requestedSource: "tools.exec.security",
      host: "allowlist",
      effective: "allowlist",
    });
    expect(summary.ask).toMatchObject({
      requested: "off",
      requestedSource: "tools.exec.ask",
      host: "always",
      effective: "always",
    });
  });

  it("reports askFallback from the OpenClaw default when approvals omit it", () => {
    const summary = resolveExecPolicyScopeSummary({
      approvals: {
        version: 1,
        agents: {},
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expect(summary.askFallback).toEqual({
      effective: "full",
      source: "OpenClaw default (full)",
    });
  });

  it("collects global, configured-agent, and approvals-only agent scopes", () => {
    const snapshots = collectExecPolicyScopeSnapshots({
      cfg: {
        tools: {
          exec: {
            security: "full",
            ask: "off",
          },
        },
        agents: {
          list: [{ id: "runner" }],
        },
      } satisfies OpenClawConfig,
      approvals: {
        version: 1,
        agents: {
          runner: {
            security: "allowlist",
          },
          batch: {
            ask: "always",
          },
        },
      },
    });

    expect(snapshots.map((snapshot) => snapshot.scopeLabel)).toEqual([
      "tools.exec",
      "agent:batch",
      "agent:runner",
    ]);
    expect(snapshots[1]?.ask).toMatchObject({
      requested: "off",
      requestedSource: "tools.exec.ask",
      host: "always",
      effective: "always",
    });
    expect(snapshots[2]?.security).toMatchObject({
      requested: "full",
      requestedSource: "tools.exec.security",
      host: "allowlist",
      effective: "allowlist",
    });
  });

  it("avoids a duplicate default-agent scope when main only appears in approvals", () => {
    const snapshots = collectExecPolicyScopeSnapshots({
      cfg: {
        tools: {
          exec: {
            security: "full",
            ask: "off",
          },
        },
      } satisfies OpenClawConfig,
      approvals: {
        version: 1,
        agents: {
          [DEFAULT_AGENT_ID]: {
            security: "allowlist",
            ask: "always",
          },
        },
      },
    });

    expect(snapshots.map((snapshot) => snapshot.scopeLabel)).toEqual(["tools.exec"]);
    expect(snapshots[0]?.security).toMatchObject({
      host: "allowlist",
      hostSource: "~/.openclaw/exec-approvals.json agents.main.security",
    });
    expect(snapshots[0]?.ask).toMatchObject({
      host: "always",
      hostSource: "~/.openclaw/exec-approvals.json agents.main.ask",
    });
  });

  it("keeps the default agent scope when main has an explicit exec override", () => {
    const snapshots = collectExecPolicyScopeSnapshots({
      cfg: {
        tools: {
          exec: {
            security: "full",
            ask: "off",
          },
        },
        agents: {
          list: [
            {
              id: DEFAULT_AGENT_ID,
              tools: {
                exec: {
                  ask: "always",
                },
              },
            },
          ],
        },
      } satisfies OpenClawConfig,
      approvals: {
        version: 1,
      },
    });

    expect(snapshots.map((snapshot) => snapshot.scopeLabel)).toEqual(["tools.exec", "agent:main"]);
    expect(snapshots[1]?.ask).toMatchObject({
      requested: "always",
      requestedSource: "agents.list.main.tools.exec.ask",
    });
  });
});
