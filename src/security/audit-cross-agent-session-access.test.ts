import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectCrossAgentSessionAccessFindings } from "./audit-extra.summary.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";

const checkId = "security.trust_model.cross_agent_session_access_default";
const agents = { entries: { home: {}, work: {} } };
const sessionTools = [
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_send",
  "session_status",
];

describe("security audit cross-agent session access", () => {
  it.each<{ name: string; cfg: OpenClawConfig }>([
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
    {
      name: "agents with all session tools removed",
      cfg: {
        agents: {
          entries: {
            home: { tools: { deny: sessionTools } },
            work: { tools: { deny: sessionTools } },
          },
        },
      },
    },
  ])("does not flag $name", ({ cfg }) => {
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
        "Agents: home, work",
        'tools.sessions.visibility resolves to "all"',
        "tools.agentToAgent",
        "Agents that can reach other agents' sessions, including other users' transcripts:",
        ...["home", "work"].map(
          (id) =>
            `- ${id}: unsandboxed sessions; allowed session tools: ${sessionTools.join(", ")}.`,
        ),
        "Incognito sessions remain hidden.",
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
        `- home: unsandboxed sessions; allowed session tools: ${sessionTools.join(", ")}.\n` +
          "- work: sandboxed sessions clamped to their spawn tree; its transcripts remain readable by the agents above.",
      ],
    },
    {
      name: "non-main sandboxing that keeps main sessions unsandboxed",
      cfg: { agents: { ...agents, defaults: { sandbox: { mode: "non-main" } } } },
      detail: ["- home: unsandboxed main session;", "- work: unsandboxed main session;"],
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
        "- home: sandboxed sessions (clamp disabled); allowed session tools:",
        "- work: sandboxed sessions (clamp disabled); allowed session tools:",
      ],
      absent: "unsandboxed",
    },
    {
      name: "an agent with all session tools removed",
      cfg: {
        agents: { entries: { home: {}, work: { tools: { deny: sessionTools } } } },
      },
      detail: [
        `- home: unsandboxed sessions; allowed session tools: ${sessionTools.join(", ")}.\n` +
          "- work: session tools removed by agent tool policy; its transcripts remain readable by the agents above.",
      ],
      absent: "- work: unsandboxed",
    },
    {
      name: "an agent with only session status allowed",
      cfg: {
        agents: { entries: { home: {}, work: { tools: { profile: "minimal" } } } },
      },
      detail: [
        `- home: unsandboxed sessions; allowed session tools: ${sessionTools.join(", ")}.\n` +
          "- work: unsandboxed sessions; allowed session tools: session_status.\n",
      ],
    },
    {
      name: "a non-reaching agent before a reaching agent in the roster",
      cfg: {
        agents: { entries: { home: { tools: { deny: sessionTools } }, work: {} } },
      },
      detail: [
        "Agents: home, work",
        `- work: unsandboxed sessions; allowed session tools: ${sessionTools.join(", ")}.\n` +
          "- home: session tools removed by agent tool policy; its transcripts remain readable by the agents above.",
      ],
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig; detail: string[]; absent?: string }>)(
    "renders session reach for $name",
    ({ cfg, detail, absent }) => {
      const findings = collectCrossAgentSessionAccessFindings(cfg);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ checkId, severity: "warn" });
      for (const fragment of detail) {
        expect(findings[0]!.detail).toContain(fragment);
      }
      if (absent) {
        expect(findings[0]!.detail).not.toContain(absent);
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
