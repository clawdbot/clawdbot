// Canonical durable approval presentation safety tests.
import { describe, expect, it } from "vitest";
import { buildApprovalPresentation } from "./approval-presentation.js";
import { PLUGIN_APPROVAL_DETAIL_MAX_LENGTH } from "./plugin-approvals.js";

const allowedDecisions = ["allow-once", "deny"] as const;

function buildExecPresentation(request: {
  command: string;
  host?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
}) {
  return buildApprovalPresentation({ kind: "exec", request, allowedDecisions });
}

function buildPluginPresentation(request: {
  title: string;
  description: string;
  detail?: string;
  pluginId?: string;
  toolName?: string;
  agentId?: string;
}) {
  return buildApprovalPresentation({ kind: "plugin", request, allowedDecisions });
}

describe("buildApprovalPresentation", () => {
  it.each([
    { kind: "exec", request: { command: "printf safe" } },
    {
      kind: "plugin",
      request: { title: "Review payment", description: "The plugin needs operator consent." },
    },
  ] as const)("sanitizes $kind scope and drops scope that exceeds its wire bound", (params) => {
    const scope = {
      kind: "payment",
      amount: "49.99",
      currency: "EUR",
      target: "Stripe\u202E",
    } as const;
    const presentation = buildApprovalPresentation({
      ...params,
      request: { ...params.request, scope },
      allowedDecisions,
    });

    expect(presentation).toMatchObject({
      kind: params.kind,
      scope: { ...scope, target: "Stripe\\u{202E}" },
    });

    const oversizedScopePresentation = buildApprovalPresentation({
      ...params,
      request: { ...params.request, scope: { ...scope, target: `${"x".repeat(125)}\u202E` } },
      allowedDecisions,
    });

    expect(oversizedScopePresentation).toMatchObject({ kind: params.kind });
    expect(oversizedScopePresentation).not.toHaveProperty("scope");
  });

  it("sanitizes exec routing metadata and preserves empty values as null", () => {
    const githubToken = `ghp_${"a".repeat(100)}`;
    const presentation = buildExecPresentation({
      command: "printf safe",
      host: "gate\nway\u202E",
      nodeId: "node\u0000id",
      agentId: githubToken,
    });

    expect(presentation).toMatchObject({
      kind: "exec",
      host: "gate\\u{A}way\\u{202E}",
      nodeId: "node\\u{0}id",
    });
    expect(JSON.stringify(presentation)).not.toContain(githubToken);
    expect(
      buildExecPresentation({
        command: "printf safe",
        host: "   ",
        nodeId: null,
        agentId: "\t",
      }),
    ).toMatchObject({ kind: "exec", host: null, nodeId: null, agentId: null });
  });

  it("escapes control and bidi spoofing while preserving description line breaks", () => {
    const presentation = buildPluginPresentation({
      title: "Deploy\u202Eprod\nnow",
      description: "Line one\r\nLine two\u0000\u202E",
      detail: "Input one\r\nInput two\u0000\u202E",
      pluginId: "plugin\u202Eid",
      toolName: "tool\nname",
      agentId: "agent\u0000id",
    });

    expect(presentation).toMatchObject({
      kind: "plugin",
      title: "Deploy\\u{202E}prod\\u{A}now",
      description: "Line one\nLine two\\u{0}\\u{202E}",
      detail: "Input one\nInput two\\u{0}\\u{202E}",
      pluginId: "plugin\\u{202E}id",
      toolName: "tool\\u{A}name",
      agentId: "agent\\u{0}id",
    });
  });

  it("redacts secret-like content before applying presentation length limits", () => {
    const githubToken = `ghp_${"a".repeat(100)}`;
    const openAiToken = "sk-abc123456789012345678";
    const presentation = buildPluginPresentation({
      title: githubToken,
      description: `Token:\n${openAiToken}`,
      pluginId: githubToken,
      toolName: openAiToken,
      agentId: `operator-${githubToken}`,
    });

    expect(presentation).not.toBeNull();
    const serialized = JSON.stringify(presentation);
    expect(serialized).not.toContain(githubToken);
    expect(serialized).not.toContain(openAiToken);
    expect(presentation).toMatchObject({
      kind: "plugin",
      description: expect.stringContaining("Token:\n"),
    });
  });

  it("applies plugin limits by Unicode code point after sanitization", () => {
    const title = String.fromCodePoint(0x1f680).repeat(80);
    const description = String.fromCodePoint(0x1f6e1).repeat(512);

    expect(buildPluginPresentation({ title, description })).toMatchObject({
      kind: "plugin",
      title,
      description,
    });
    const truncatedTitle = buildPluginPresentation({
      title: `${title}${String.fromCodePoint(0x1f680)}`,
      description,
    });
    expect(truncatedTitle).toMatchObject({
      kind: "plugin",
      title: expect.stringMatching(/…$/u),
    });
    if (truncatedTitle?.kind !== "plugin") {
      throw new Error("expected plugin presentation");
    }
    expect(Array.from(truncatedTitle.title)).toHaveLength(80);
    const truncatedDescription = buildPluginPresentation({
      title,
      description: `${description}${String.fromCodePoint(0x1f6e1)}`,
    });
    expect(truncatedDescription).toMatchObject({
      kind: "plugin",
      description: expect.stringMatching(/…$/u),
    });
    if (truncatedDescription?.kind !== "plugin") {
      throw new Error("expected plugin presentation");
    }
    expect(Array.from(truncatedDescription.description)).toHaveLength(512);
  });

  it("does not double-escape channel entities when re-projecting stored plugin copy", () => {
    const storedTitle = "deploy &amp; ship";
    const presentation = buildPluginPresentation({
      title: storedTitle,
      description: "Command: foo && bar",
    });

    expect(presentation).toMatchObject({
      kind: "plugin",
      title: storedTitle,
      description: expect.stringContaining("&amp;&amp;"),
    });
    expect(JSON.stringify(presentation)).not.toContain("&amp;amp;");
  });

  it("escapes Slack mrkdwn and mention triggers in plugin presentation text", () => {
    const presentation = buildPluginPresentation({
      title: "*Run* @channel",
      description: "ACP tool kind: execute. Command: `rm -rf /` <https://evil.test|click>",
    });

    expect(presentation).toMatchObject({
      kind: "plugin",
      title: "\u2217Run\u2217 \uff20channel",
      description: expect.not.stringContaining("@channel"),
    });
    const serialized = JSON.stringify(presentation);
    expect(serialized).not.toContain("*Run*");
    expect(serialized).not.toContain("@channel");
    expect(serialized).not.toContain("<https://evil.test|click>");
  });

  it("truncates oversized plugin detail without invalidating the presentation", () => {
    const presentation = buildPluginPresentation({
      title: "Review tool input",
      description: "Bounded channel summary",
      detail: "x".repeat(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH + 1),
    });

    expect(presentation).toMatchObject({
      kind: "plugin",
      detail: expect.stringMatching(/…\[truncated\]$/u),
    });
    if (presentation?.kind !== "plugin" || !presentation.detail) {
      throw new Error("expected plugin detail");
    }
    expect(Array.from(presentation.detail)).toHaveLength(PLUGIN_APPROVAL_DETAIL_MAX_LENGTH);
  });
});

describe("buildApprovalPresentation (system-agent)", () => {
  function buildSystemAgentPresentation(request: { title: string; description: string }) {
    return buildApprovalPresentation({
      kind: "system-agent",
      request: {
        ...request,
        command: "true",
        proposalHash: "a".repeat(64),
        allowedDecisions,
        sessionId: "s1",
      },
      allowedDecisions,
    });
  }

  it("drops a split emoji at the title boundary instead of leaving a lone surrogate", () => {
    const title = `${"a".repeat(79)}\u{1F600}`;
    const presentation = buildSystemAgentPresentation({ title, description: "d" });
    expect(presentation).toMatchObject({ kind: "system-agent", title: "a".repeat(79) });
  });

  it("keeps an emoji that fits within the title limit intact", () => {
    const title = `${"a".repeat(78)}\u{1F600}`;
    const presentation = buildSystemAgentPresentation({ title, description: "d" });
    expect(presentation).toMatchObject({ kind: "system-agent", title });
  });

  it("drops a split emoji at the description boundary instead of leaving a lone surrogate", () => {
    const description = `${"a".repeat(511)}\u{1F6E1}`;
    const presentation = buildSystemAgentPresentation({ title: "t", description });
    expect(presentation).toMatchObject({
      kind: "system-agent",
      description: "a".repeat(511),
    });
  });
});
