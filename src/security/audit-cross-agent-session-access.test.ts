import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectCrossAgentSessionAccessFindings } from "./audit-extra.summary.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";

const checkId = "security.trust_model.cross_agent_session_access_default";
const agents = { entries: { home: {}, work: {} } };

describe("security audit cross-agent session access", () => {
  it.each([
    { name: "one implicit agent", cfg: {} },
    { name: "one explicit agent", cfg: { agents: { entries: { home: {} } } } },
    ...(["agent", "tree", "self"] as const).map((visibility) => ({
      name: `${visibility} visibility`,
      cfg: { agents, tools: { sessions: { visibility } } },
    })),
    {
      name: "disabled agent-to-agent access",
      cfg: { agents, tools: { agentToAgent: { enabled: false } } },
    },
    ...[["home", "work"], ["*"], [" "]].map((allow) => ({
      name: `configured allow list ${JSON.stringify(allow)}`,
      cfg: { agents, tools: { agentToAgent: { allow } } },
    })),
    {
      name: "agents that are all fully sandboxed under the default clamp",
      cfg: { agents: { ...agents, defaults: { sandbox: { mode: "all" } } } },
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig }>)("does not flag $name", ({ cfg }) => {
    expect(collectCrossAgentSessionAccessFindings(cfg)).toEqual([]);
  });

  it.each([
    { name: "default entries roster", cfg: { agents } },
    { name: "list roster", cfg: { agents: { list: [{ id: "home" }, { id: "work" }] } } },
    {
      name: "explicit all visibility and empty allow list",
      cfg: {
        agents,
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: [] } },
      },
    },
    {
      name: "invalid visibility resolving to all",
      cfg: { agents, tools: { sessions: { visibility: "invalid" } } } as unknown as OpenClawConfig,
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig }>)(
    "reports one informational finding for $name",
    ({ cfg }) => {
      const findings = collectCrossAgentSessionAccessFindings(cfg);
      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding).toMatchObject({
        checkId,
        severity: "info",
        title: "Agents share Gateway-wide session access (default)",
      });
      for (const detail of [
        "home",
        "work",
        'tools.sessions.visibility resolves to "all"',
        "tools.agentToAgent",
        "list, read, search, and message",
        "other users' transcripts",
        "spawn tree",
      ]) {
        expect(finding.detail).toContain(detail);
      }
      for (const remediation of [
        "tools.sessions.visibility",
        '"agent", "tree", or "self"',
        "tools.agentToAgent.allow",
        "requester and target ids",
        "tools.agentToAgent.enabled: false",
        "https://docs.openclaw.ai/gateway/config-tools#tools-agenttoagent",
        "https://docs.openclaw.ai/gateway/security#scope-one-trust-boundary-per-gateway",
      ]) {
        expect(finding.remediation).toContain(remediation);
      }
    },
  );

  it.each([
    {
      name: "sandboxed agent",
      cfg: { agents: { entries: { home: {}, work: { sandbox: { mode: "all" } } } } },
      signals: ['work: sandbox.mode="all"'],
    },
    {
      name: "inherited non-main sandbox",
      cfg: { agents: { ...agents, defaults: { sandbox: { mode: "non-main" } } } },
      signals: ['home: sandbox.mode="non-main"', 'work: sandbox.mode="non-main"'],
    },
    ...[
      { tools: { deny: ["exec"] }, signal: "tools.deny" },
      { tools: { allow: [] }, signal: "tools.allow" },
      { tools: { profile: "messaging" as const }, signal: "tools.profile" },
    ].map(({ tools, signal }) => ({
      name: `agent-level ${signal}`,
      cfg: { agents: { entries: { home: {}, work: { tools } } } },
      signals: [`work: agent-level tool restrictions (${signal})`],
    })),
    {
      name: "multi-user ingress",
      cfg: { agents, channels: { slack: { dmPolicy: "open" } } },
      signals: ['channels.slack.dmPolicy="open"'],
    },
    {
      name: "combined trust-boundary signals",
      cfg: {
        agents: {
          entries: { home: {}, work: { sandbox: { mode: "all" }, tools: { deny: ["exec"] } } },
        },
        channels: { slack: { dmPolicy: "open" } },
      },
      signals: [
        'work: sandbox.mode="all"',
        "work: agent-level tool restrictions (tools.deny)",
        'channels.slack.dmPolicy="open"',
      ],
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig; signals: string[] }>)(
    "warns for $name",
    ({ cfg, signals }) => {
      const findings = collectCrossAgentSessionAccessFindings(cfg);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ checkId, severity: "warn" });
      expect(findings[0]!.detail).toContain("different trust levels");
      for (const signal of signals) {
        expect(findings[0]!.detail).toContain(signal);
      }
    },
  );

  it.each([
    {
      name: "a sandboxed agent under the default clamp",
      cfg: { agents: { entries: { home: {}, work: { sandbox: { mode: "all" } } } } },
      detail: [
        "the agents with unsandboxed sessions (home)",
        "Sandboxed sessions (work) stay clamped to their spawn tree",
        "remain readable by the unsandboxed callers",
      ],
    },
    {
      name: "non-main sandboxing that keeps main sessions unsandboxed",
      cfg: { agents: { ...agents, defaults: { sandbox: { mode: "non-main" } } } },
      detail: ["every listed agent", "Sandboxed sessions (home, work) stay clamped"],
    },
    {
      name: "fully sandboxed agents with the clamp disabled",
      cfg: {
        agents: {
          ...agents,
          defaults: { sandbox: { mode: "all", sessionToolsVisibility: "all" } },
        },
      },
      detail: [
        "every listed agent",
        'Sandboxed sessions (home, work) are not clamped because agents.defaults.sandbox.sessionToolsVisibility is "all"',
      ],
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig; detail: string[] }>)(
    "renders sandbox reach for $name",
    ({ cfg, detail }) => {
      const findings = collectCrossAgentSessionAccessFindings(cfg);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ checkId, severity: "warn" });
      for (const fragment of detail) {
        expect(findings[0]!.detail).toContain(fragment);
      }
    },
  );

  it("registers the finding in the non-deep config audit", async () => {
    const findings = await collectSecurityAuditFindings({ agents });
    expect(findings.filter((finding) => finding.checkId === checkId)).toEqual([
      expect.objectContaining({ severity: "info" }),
    ]);
  });
});
