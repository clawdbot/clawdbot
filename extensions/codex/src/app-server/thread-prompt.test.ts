import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";

const delegationTools: CodexDynamicToolSpec[] = [
  {
    type: "function",
    name: "sessions_spawn",
    description: "Spawn an OpenClaw session",
    inputSchema: { type: "object" },
  },
  {
    type: "function",
    name: "sessions_send",
    description: "Send to an OpenClaw session",
    inputSchema: { type: "object" },
  },
  {
    type: "function",
    name: "subagents",
    description: "List OpenClaw subagents",
    inputSchema: { type: "object" },
  },
  {
    type: "namespace",
    name: CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
    description: "Direct OpenClaw tools",
    tools: [
      {
        type: "function",
        name: "sessions_yield",
        description: "Yield for OpenClaw session events",
        inputSchema: { type: "object" },
      },
    ],
  },
];

function createParams(overrides: Partial<EmbeddedRunAttemptParams> = {}): EmbeddedRunAttemptParams {
  return {
    agentId: "main",
    config: {},
    modelId: "gpt-5.6-luna",
    sessionKey: "agent:main:main",
    sourceReplyDeliveryMode: "automatic",
    ...overrides,
  } as EmbeddedRunAttemptParams;
}

function buildInstructions(overrides: Partial<EmbeddedRunAttemptParams> = {}): string {
  return buildDeveloperInstructions(createParams(overrides), {
    dynamicTools: delegationTools,
  });
}

describe("buildDeveloperInstructions delegation guidance", () => {
  it("shares the visible-session delegation policy with a canonical main session", () => {
    const instructions = buildInstructions();

    expect(instructions).toContain("## Delegation");
    expect(instructions).toContain("delegate via native `spawn_agent`");
    expect(instructions).toContain("spawn `sessions_spawn` with `visible=true`");
    expect(instructions.indexOf("## Delegation")).toBeGreaterThan(
      instructions.indexOf("When a native child's result belongs in a later turn"),
    );
    expect(instructions.indexOf("## Delegation")).toBeLessThan(
      instructions.indexOf("For the current source conversation"),
    );
  });

  it("omits the policy outside the canonical main session", () => {
    expect(buildInstructions({ sessionKey: "agent:main:slack:channel:C01234567" })).not.toContain(
      "## Delegation",
    );
  });

  it("honors an explicit suggest mode in the canonical main session", () => {
    expect(
      buildInstructions({
        config: { agents: { defaults: { subagents: { delegationMode: "suggest" } } } },
      }),
    ).not.toContain("## Delegation");
  });

  it.each([
    { name: "report-only delegation", overrides: { delegationCapability: "report_only" } },
    { name: "disabled tools", overrides: { disableTools: true } },
    // Subagent runs must not be told to delegate again; the native runtime
    // suppresses the same section for minimal/none prompt modes.
    { name: "minimal subagent prompt mode", overrides: { promptMode: "minimal" } },
    { name: "prompt mode none", overrides: { promptMode: "none" } },
  ] as const)("omits the policy for $name", ({ overrides }) => {
    expect(buildInstructions(overrides)).not.toContain("## Delegation");
  });
});

describe("buildDeveloperInstructions credential guidance", () => {
  const secretTool: CodexDynamicToolSpec = {
    type: "function",
    name: "secrets",
    description: "Request protected credentials",
    inputSchema: { type: "object" },
  };

  it.each([
    { name: "direct", dynamicTools: [secretTool], toolName: "secrets" },
    {
      name: "deferred",
      dynamicTools: [{ ...secretTool, deferLoading: true }],
      toolName: "secrets",
    },
    {
      name: "namespaced",
      dynamicTools: [
        { type: "namespace", name: "openclaw", description: "Tools", tools: [secretTool] },
      ],
      toolName: "openclaw.secrets",
    },
  ] satisfies { name: string; dynamicTools: CodexDynamicToolSpec[]; toolName: string }[])(
    "teaches the actual $name credential route",
    ({ dynamicTools, toolName }) => {
      const instructions = buildDeveloperInstructions(createParams(), { dynamicTools });
      expect(instructions).toContain(`\`${toolName}\`: list metadata first`);
      expect(instructions).toContain("request only missing task-needed credentials: name + reason");
      expect(instructions).toContain("exact allowedHosts for egress");
      expect(instructions).toContain("Human masked entry -> protected shared store");
      expect(instructions).toContain("metadata/ref only");
      expect(instructions).toContain("returned store SecretRef on supported config fields");
      expect(instructions).toContain("Gateway egress needs enabled proxy + allowed hosts");
      expect(instructions).toContain("no plaintext fallback");
      expect(instructions).toContain(
        "no_answer: report blocker or continue with best judgment; never ask in chat",
      );
    },
  );

  it.each([
    { name: "absent", options: { dynamicTools: [] }, overrides: {} },
    { name: "unsupplied", options: {}, overrides: {} },
    {
      name: "disabled",
      options: { dynamicTools: [secretTool] },
      overrides: { disableTools: true },
    },
  ])("keeps safety but hides the named credential route when $name", ({ options, overrides }) => {
    const instructions = buildDeveloperInstructions(createParams(overrides), options);
    expect(instructions).not.toContain("`secrets`");
    expect(instructions).not.toContain("SecretRef");
    expect(instructions).toContain("host-owned masked credential entry");
    expect(instructions).toContain("safe external setup");
  });
});
