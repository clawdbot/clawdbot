// Tests execution approval policy matching and persistence.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  makeMockCommandResolution,
  makeMockExecutableResolution,
} from "./exec-approvals-test-helpers.js";
import type { ExecApprovalsFile } from "./exec-approvals.js";
import { buildHashedArgPatternFromArgv } from "./exec-command-resolution.js";

vi.unmock("./exec-approvals.js");
vi.unmock("./exec-approvals-effective.js");

let collectExecPolicyScopeSnapshots: typeof import("./exec-approvals-effective.js").collectExecPolicyScopeSnapshots;
let resolveExecPolicyScopeSnapshot: typeof import("./exec-approvals-effective.js").resolveExecPolicyScopeSnapshot;
let evaluateExecAllowlist: typeof import("./exec-approvals.js").evaluateExecAllowlist;
let hasDurableExecApproval: typeof import("./exec-approvals.js").hasDurableExecApproval;
let maxAsk: typeof import("./exec-approvals.js").maxAsk;
let minSecurity: typeof import("./exec-approvals.js").minSecurity;
let requireValidExecTarget: typeof import("./exec-approvals.js").requireValidExecTarget;
let normalizeExecAsk: typeof import("./exec-approvals.js").normalizeExecAsk;
let normalizeExecHost: typeof import("./exec-approvals.js").normalizeExecHost;
let normalizeExecMode: typeof import("./exec-approvals.js").normalizeExecMode;
let normalizeExecTarget: typeof import("./exec-approvals.js").normalizeExecTarget;
let normalizeExecSecurity: typeof import("./exec-approvals.js").normalizeExecSecurity;
let requiresExecApproval: typeof import("./exec-approvals.js").requiresExecApproval;
let normalizeExecApprovalUnavailableDecisions: typeof import("./exec-approvals.js").normalizeExecApprovalUnavailableDecisions;
let resolveExecApprovalUnavailableDecisions: typeof import("./exec-approvals.js").resolveExecApprovalUnavailableDecisions;
let resolveExecApprovalRequestAllowedDecisions: typeof import("./exec-approvals.js").resolveExecApprovalRequestAllowedDecisions;
let resolveExecModeFromPolicy: typeof import("./exec-approvals.js").resolveExecModeFromPolicy;
let resolveExecModePolicy: typeof import("./exec-approvals.js").resolveExecModePolicy;
let resolveExecPolicyForMode: typeof import("./exec-approvals.js").resolveExecPolicyForMode;

async function loadActualExecApprovalModules(): Promise<void> {
  vi.resetModules();
  const execApprovals =
    await vi.importActual<typeof import("./exec-approvals.js")>("./exec-approvals.js");
  const effective = await vi.importActual<typeof import("./exec-approvals-effective.js")>(
    "./exec-approvals-effective.js",
  );
  collectExecPolicyScopeSnapshots = effective.collectExecPolicyScopeSnapshots;
  resolveExecPolicyScopeSnapshot = effective.resolveExecPolicyScopeSnapshot;
  evaluateExecAllowlist = execApprovals.evaluateExecAllowlist;
  hasDurableExecApproval = execApprovals.hasDurableExecApproval;
  maxAsk = execApprovals.maxAsk;
  minSecurity = execApprovals.minSecurity;
  requireValidExecTarget = execApprovals.requireValidExecTarget;
  normalizeExecAsk = execApprovals.normalizeExecAsk;
  normalizeExecHost = execApprovals.normalizeExecHost;
  normalizeExecMode = execApprovals.normalizeExecMode;
  normalizeExecTarget = execApprovals.normalizeExecTarget;
  normalizeExecSecurity = execApprovals.normalizeExecSecurity;
  requiresExecApproval = execApprovals.requiresExecApproval;
  normalizeExecApprovalUnavailableDecisions =
    execApprovals.normalizeExecApprovalUnavailableDecisions;
  resolveExecApprovalUnavailableDecisions = execApprovals.resolveExecApprovalUnavailableDecisions;
  resolveExecApprovalRequestAllowedDecisions =
    execApprovals.resolveExecApprovalRequestAllowedDecisions;
  resolveExecModeFromPolicy = execApprovals.resolveExecModeFromPolicy;
  resolveExecModePolicy = execApprovals.resolveExecModePolicy;
  resolveExecPolicyForMode = execApprovals.resolveExecPolicyForMode;
}

function summarizeExecPolicyScopeSnapshot(
  params: Parameters<typeof resolveExecPolicyScopeSnapshot>[0],
): Omit<ReturnType<typeof resolveExecPolicyScopeSnapshot>, "allowedDecisions"> {
  const { allowedDecisions: _allowedDecisions, ...summary } =
    resolveExecPolicyScopeSnapshot(params);
  return summary;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

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
  const summary = summarizeExecPolicyScopeSnapshot({
    approvals,
    globalExecConfig: {
      ask: "off",
    },
    configPath: "agents.list.runner.tools.exec",
    scopeLabel: "agent:runner",
    agentId: "runner",
  });

  expectFields(summary.ask, {
    requested: "off",
    host: "always",
    hostSource: "~/.openclaw/exec-approvals.json defaults.ask",
    effective: "always",
    note: "more aggressive ask wins",
  });
}

describe("exec approvals policy helpers", () => {
  beforeEach(async () => {
    await loadActualExecApprovalModules();
  });

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

  it("requires direct exec target requests to use the closed host set", () => {
    expect(requireValidExecTarget(" gateway ")).toBe("gateway");
    expect(requireValidExecTarget("")).toBe(null);
    expect(requireValidExecTarget(undefined)).toBe(null);
    expect(() => requireValidExecTarget("spark-ff13")).toThrow(
      'Invalid exec host "spark-ff13". Allowed values: auto, sandbox, gateway, node.',
    );
    expect(() => requireValidExecTarget(42)).toThrow(
      "Invalid exec host value type number. Allowed values: auto, sandbox, gateway, node.",
    );
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
    { raw: " auto ", expected: "auto" },
    { raw: "ASK", expected: "ask" },
    { raw: "allowlist", expected: "allowlist" },
    { raw: "maybe", expected: null },
  ])("normalizes exec mode value %j", ({ raw, expected }) => {
    expect(normalizeExecMode(raw)).toBe(expected);
  });

  it.each([
    { security: "deny" as const, ask: "off" as const, expected: "deny" as const },
    {
      security: "allowlist" as const,
      ask: "off" as const,
      expected: "allowlist" as const,
    },
    {
      security: "allowlist" as const,
      ask: "on-miss" as const,
      expected: "ask" as const,
    },
    { security: "full" as const, ask: "off" as const, expected: "full" as const },
    { security: "full" as const, ask: "on-miss" as const, expected: "full" as const },
    { security: "full" as const, ask: "always" as const, expected: "ask" as const },
  ])("derives normalized exec mode from legacy policy %j", ({ security, ask, expected }) => {
    expect(resolveExecModeFromPolicy({ security, ask })).toBe(expected);
  });

  it.each([
    {
      mode: "deny" as const,
      expected: { security: "deny" as const, ask: "off" as const, autoReview: false },
    },
    {
      mode: "allowlist" as const,
      expected: { security: "allowlist" as const, ask: "off" as const, autoReview: false },
    },
    {
      mode: "ask" as const,
      expected: { security: "allowlist" as const, ask: "on-miss" as const, autoReview: false },
    },
    {
      mode: "auto" as const,
      expected: { security: "allowlist" as const, ask: "on-miss" as const, autoReview: true },
    },
    {
      mode: "full" as const,
      expected: { security: "full" as const, ask: "off" as const, autoReview: false },
    },
  ])("maps explicit exec mode to effective policy %j", ({ mode, expected }) => {
    expect(resolveExecPolicyForMode(mode)).toEqual(expected);
  });

  it("preserves legacy security and ask when no explicit mode is set", () => {
    expect(
      resolveExecModePolicy({
        security: "full",
        ask: "always",
      }),
    ).toEqual({
      mode: "ask",
      security: "full",
      ask: "always",
      autoReview: false,
    });
  });

  it("treats unavailable request decisions as optional approvals only", () => {
    expect(
      normalizeExecApprovalUnavailableDecisions(["allow-once", "deny", "allow-always", "bad"]),
    ).toEqual(["allow-always"]);
    expect(
      resolveExecApprovalRequestAllowedDecisions({
        ask: "on-miss",
        unavailableDecisions: ["allow-always"],
      }),
    ).toEqual(["allow-once", "deny"]);
    expect(
      resolveExecApprovalRequestAllowedDecisions({
        ask: "on-miss",
        unavailableDecisions: ["allow-once", "deny", "allow-always", "bad"],
      }),
    ).toEqual(["allow-once", "deny"]);
    expect(
      resolveExecApprovalRequestAllowedDecisions({
        ask: "always",
        unavailableDecisions: ["allow-always"],
      }),
    ).toEqual(["allow-once", "deny"]);
  });

  it("derives unavailable optional decisions from effective approval policy", () => {
    expect(resolveExecApprovalUnavailableDecisions({ ask: "on-miss" })).toEqual([]);
    expect(resolveExecApprovalUnavailableDecisions({ ask: "always" })).toEqual(["allow-always"]);
    expect(
      resolveExecApprovalUnavailableDecisions({
        ask: "on-miss",
        allowAlwaysPersistence: { kind: "one-shot", reasons: ["no-reusable-pattern"] },
      }),
    ).toEqual(["allow-always"]);
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
      resolvedRealPath: "/usr/bin/echo",
      executableName: "echo",
    });
    const allowlist = [
      {
        pattern: "/usr/bin/echo",
        argPattern: buildHashedArgPatternFromArgv(["/usr/bin/echo", "ok"]),
        source: "allow-always" as const,
      },
    ];
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
      allowlist,
      safeBins: new Set(),
      cwd: "/tmp",
      platform: process.platform,
    });

    expect(result.allowlistSatisfied).toBe(false);
    expect(result.segmentAllowlistEntries).toHaveLength(2);
    expectFields(result.segmentAllowlistEntries[0], { pattern: "/usr/bin/echo" });
    expect(result.segmentAllowlistEntries[1]).toBeNull();
    expect(
      hasDurableExecApproval({
        analysisOk: true,
        segmentAllowlistEntries: result.segmentAllowlistEntries,
        allowlist,
      }),
    ).toBe(false);
  });

  it("explains stricter host security and ask precedence", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
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

    expectFields(summary.security, {
      requested: "full",
      host: "allowlist",
      effective: "allowlist",
      hostSource: "~/.openclaw/exec-approvals.json defaults.security",
      note: "stricter host security wins",
    });
    expectFields(summary.ask, {
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

  it("maps normalized requested mode into policy snapshots", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: {
        version: 1,
      },
      scopeExecConfig: {
        mode: "auto",
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expectFields(summary.mode, {
      requested: "auto",
      requestedSource: "tools.exec.mode",
      effective: "auto",
      note: "requested mode applies",
    });
    expectFields(summary.security, {
      requested: "allowlist",
      requestedSource: "tools.exec.mode",
      effective: "allowlist",
    });
    expectFields(summary.ask, {
      requested: "on-miss",
      requestedSource: "tools.exec.mode",
      effective: "on-miss",
    });
  });

  it("lets narrower legacy policy override a global normalized mode in snapshots", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: {
        version: 1,
      },
      globalExecConfig: {
        mode: "deny",
      },
      scopeExecConfig: {
        security: "full",
        ask: "off",
      },
      configPath: "agents.list.runner.tools.exec",
      scopeLabel: "agent:runner",
      agentId: "runner",
    });

    expectFields(summary.mode, {
      requested: "full",
      requestedSource:
        "derived from agents.list.runner.tools.exec.security and agents.list.runner.tools.exec.ask",
      effective: "full",
    });
    expectFields(summary.security, {
      requested: "full",
      requestedSource: "agents.list.runner.tools.exec.security",
      effective: "full",
    });
  });

  it("preserves mode-derived siblings for partial narrower legacy policy snapshots", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: {
        version: 1,
      },
      globalExecConfig: {
        mode: "auto",
      },
      scopeExecConfig: {
        ask: "off",
      },
      configPath: "agents.list.runner.tools.exec",
      scopeLabel: "agent:runner",
      agentId: "runner",
    });

    expectFields(summary.security, {
      requested: "allowlist",
      requestedSource: "tools.exec.mode",
    });
    expectFields(summary.ask, {
      requested: "off",
      requestedSource: "agents.list.runner.tools.exec.ask",
    });
    expectFields(summary.mode, {
      requested: "allowlist",
      effective: "allowlist",
    });
  });

  it("reports full plus on-miss as full because on-miss only gates allowlist misses", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: {
        version: 1,
      },
      globalExecConfig: {
        mode: "auto",
      },
      scopeExecConfig: {
        security: "full",
      },
      configPath: "agents.list.runner.tools.exec",
      scopeLabel: "agent:runner",
      agentId: "runner",
    });

    expectFields(summary.security, {
      requested: "full",
      requestedSource: "agents.list.runner.tools.exec.security",
    });
    expectFields(summary.ask, {
      requested: "on-miss",
      requestedSource: "tools.exec.mode",
    });
    expectFields(summary.mode, {
      requested: "full",
      effective: "full",
    });
  });

  it("uses the actual approvals path when reporting host sources", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
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

  it("uses OPENCLAW_STATE_DIR when reporting default host sources", () => {
    const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = path.join(process.cwd(), ".tmp-openclaw-state");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const summary = summarizeExecPolicyScopeSnapshot({
        approvals: {
          version: 1,
          defaults: {
            security: "allowlist",
          },
        },
        scopeExecConfig: {
          security: "full",
        },
        configPath: "tools.exec",
        scopeLabel: "tools.exec",
      });

      expect(summary.security.hostSource).toBe(
        `${path.join(stateDir, "exec-approvals.json")} defaults.security`,
      );
    } finally {
      if (originalOpenClawStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
      }
    }
  });

  it("does not let host ask=off suppress a stricter requested ask", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
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

    expectFields(summary.ask, {
      requested: "always",
      host: "off",
      effective: "always",
      note: "requested ask applies",
    });
  });

  it("clamps askFallback to the effective security", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
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
    const summary = summarizeExecPolicyScopeSnapshot({
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

    expectFields(summary.security, {
      host: "allowlist",
      hostSource: "~/.openclaw/exec-approvals.json agents.*.security",
    });
    expectFields(summary.ask, {
      host: "always",
      hostSource: "~/.openclaw/exec-approvals.json agents.*.ask",
    });
    expect(summary.askFallback).toEqual({
      effective: "deny",
      source: "~/.openclaw/exec-approvals.json agents.*.askFallback",
    });
  });

  it("inherits requested agent policy from global tools.exec config", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
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

    expectFields(summary.security, {
      requested: "full",
      requestedSource: "tools.exec.security",
      host: "allowlist",
      effective: "allowlist",
    });
    expectFields(summary.ask, {
      requested: "off",
      requestedSource: "tools.exec.ask",
      host: "always",
      effective: "always",
    });
  });

  it("reports askFallback from the OpenClaw default when approvals omit it", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: {
        version: 1,
        agents: {},
      },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
    });

    expect(summary.askFallback).toEqual({
      effective: "deny",
      source: "OpenClaw default (deny)",
    });
  });

  it("uses host-reported defaults instead of requested policy fallbacks", () => {
    const summary = summarizeExecPolicyScopeSnapshot({
      approvals: { version: 1, agents: {} },
      scopeExecConfig: { security: "full", ask: "off" },
      configPath: "tools.exec",
      scopeLabel: "tools.exec",
      hostDefaults: {
        security: "deny",
        ask: "on-miss",
        askFallback: "deny",
      },
      hostDefaultSource: "node-reported resolved defaults",
    });

    expectFields(summary.security, {
      requested: "full",
      host: "deny",
      hostSource: "node-reported resolved defaults",
      effective: "deny",
    });
    expectFields(summary.ask, {
      requested: "off",
      host: "on-miss",
      hostSource: "node-reported resolved defaults",
      effective: "on-miss",
    });
    expect(summary.askFallback.source).toBe("node-reported resolved defaults");
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
    expectFields(snapshots[1]?.ask, {
      requested: "off",
      requestedSource: "tools.exec.ask",
      host: "always",
      effective: "always",
    });
    expectFields(snapshots[2]?.security, {
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
    expectFields(snapshots[0]?.security, {
      host: "allowlist",
      hostSource: "~/.openclaw/exec-approvals.json agents.main.security",
    });
    expectFields(snapshots[0]?.ask, {
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
    expectFields(snapshots[1]?.ask, {
      requested: "always",
      requestedSource: "agents.list.main.tools.exec.ask",
    });
  });
});
