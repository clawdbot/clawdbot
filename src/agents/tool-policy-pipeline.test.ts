// Tool policy pipeline tests cover profile/allowlist filtering, diagnostics,
// warning dedupe, and plugin-aware policy application.
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildDeclaredToolAllowlistContext } from "./tool-policy-declared-context.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
  resetToolPolicyWarningCacheForTest,
} from "./tool-policy-pipeline.js";
import { resolveToolProfilePolicy } from "./tool-policy.js";

const { toolPolicyAuditDebug, toolPolicyAuditInfo } = vi.hoisted(() => ({
  toolPolicyAuditDebug: vi.fn(),
  toolPolicyAuditInfo: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: toolPolicyAuditDebug,
    info: toolPolicyAuditInfo,
  }),
}));

type DummyTool = { name: string };
type PolicyTool = Parameters<typeof applyToolPolicyPipeline>[0]["tools"][number];

function asPolicyTools(tools: DummyTool[]): PolicyTool[] {
  return tools as PolicyTool[];
}

function runAllowlistWarningStep(params: {
  allow: string[];
  label: string;
  suppressUnavailableCoreToolWarning?: boolean;
  suppressUnavailableCoreToolWarningAllowlist?: string[];
  unavailableCoreToolReason?: string;
}) {
  const warnings: string[] = [];
  const tools = [{ name: "exec" }] as unknown as DummyTool[];
  applyToolPolicyPipeline({
    tools: asPolicyTools(tools),
    toolMeta: () => undefined,
    warn: (msg) => warnings.push(msg),
    steps: [
      {
        policy: { allow: params.allow },
        label: params.label,
        stripPluginOnlyAllowlist: true,
        suppressUnavailableCoreToolWarning: params.suppressUnavailableCoreToolWarning,
        suppressUnavailableCoreToolWarningAllowlist:
          params.suppressUnavailableCoreToolWarningAllowlist,
        unavailableCoreToolReason: params.unavailableCoreToolReason,
      },
    ],
  });
  return warnings;
}

describe("tool-policy-pipeline", () => {
  beforeEach(() => {
    resetToolPolicyWarningCacheForTest();
    toolPolicyAuditDebug.mockClear();
    toolPolicyAuditInfo.mockClear();
  });

  test("preserves plugin-only allowlists instead of silently stripping them", () => {
    const tools = [{ name: "exec" }, { name: "plugin_tool" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: (t: any) => (t.name === "plugin_tool" ? { pluginId: "foo" } : undefined),
      warn: () => {},
      steps: [
        {
          policy: { allow: ["plugin_tool"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    const names = filtered.map((t) => (t as unknown as DummyTool).name).toSorted();
    expect(names).toEqual(["plugin_tool"]);
  });

  test("warns about unknown allowlist entries", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["wat"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (wat). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("suppresses built-in profile warnings for unavailable gated core tools", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch"],
      label: "tools.profile (coding)",
      suppressUnavailableCoreToolWarningAllowlist: ["apply_patch"],
    });
    expect(warnings).toStrictEqual([]);
  });

  test("still warns for profile steps when explicit alsoAllow entries are present", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch", "browser"],
      label: "tools.profile (coding)",
      suppressUnavailableCoreToolWarningAllowlist: ["apply_patch"],
    });
    expect(warnings).toEqual([
      "tools: tools.profile (coding) allowlist contains unknown entries (browser). These entries are shipped core tools but unavailable in the current runtime/provider/model/config.",
    ]);
  });

  test("still warns for explicit allowlists that mention unavailable gated core tools", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch"],
      label: "tools.allow",
    });
    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (apply_patch). These entries are shipped core tools but unavailable in the current runtime/provider/model/config.",
    ]);
  });

  test("includes the active reason for unavailable core tool warnings", () => {
    const warnings = runAllowlistWarningStep({
      allow: ["apply_patch", "wat"],
      label: "tools.allow",
      unavailableCoreToolReason:
        "memory-triggered compaction runs expose only read and append-only write",
    });
    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (apply_patch, wat). Some entries are shipped core tools but unavailable here: memory-triggered compaction runs expose only read and append-only write; other entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("default profile steps suppress unavailable baseline profile entries", () => {
    const warnings: string[] = [];
    const profilePolicy = resolveToolProfilePolicy("coding");
    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      steps: buildDefaultToolPolicyPipelineSteps({
        profile: "coding",
        profilePolicy,
        profileUnavailableCoreWarningAllowlist: profilePolicy?.allow,
      }),
    });

    expect(warnings).toStrictEqual([]);
  });

  test("does not warn for declared plugin tools that are not materialized yet", () => {
    const warnings: string[] = [];
    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: { pluginToolNames: ["llm-task"] },
      steps: [
        {
          policy: { allow: ["llm-task"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toStrictEqual([]);
  });

  test("does not warn for declared MCP server namespace globs", () => {
    const warnings: string[] = [];
    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: { mcpServerNames: ["paperless", "Home Assistant"] },
      steps: [
        {
          policy: { allow: ["paperless__*", "home-assistant__search"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toStrictEqual([]);
  });

  test("still warns for undeclared MCP namespace globs", () => {
    const warnings: string[] = [];
    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: { mcpServerNames: ["paperless"] },
      steps: [
        {
          policy: { allow: ["papreless__*"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (papreless__*). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("declared context excludes disabled plugin tools", () => {
    const declared = buildDeclaredToolAllowlistContext({
      config: { plugins: { entries: { browser: { enabled: false } } } },
      workspaceDir: process.cwd(),
    });

    expect(Array.from(declared?.pluginToolNames ?? [])).not.toContain("browser");
  });

  test("declared context excludes denied plugin tools", () => {
    const declared = buildDeclaredToolAllowlistContext({
      config: { plugins: { entries: { browser: { enabled: true } } } },
      workspaceDir: process.cwd(),
      toolDenylist: ["browser"],
    });

    expect(Array.from(declared?.pluginToolNames ?? [])).not.toContain("browser");
  });

  test("declared context excludes disabled MCP servers", () => {
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        mcp: {
          servers: {
            paperless: { command: "paperless-mcp" },
            disabled: { command: "disabled-mcp", enabled: false },
          },
        },
      },
      workspaceDir: process.cwd(),
    });

    expect(Array.from(declared?.mcpServerNames ?? [])).toContain("paperless");
    expect(Array.from(declared?.mcpServerNames ?? [])).not.toContain("disabled");
  });

  test("warns when disabled MCP server namespace is allowlisted", () => {
    const warnings: string[] = [];
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        mcp: { servers: { disabled: { command: "disabled-mcp", enabled: false } } },
      },
      workspaceDir: process.cwd(),
    });

    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: declared,
      steps: [
        {
          policy: { allow: ["disabled__*"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (disabled__*). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("warns when bundle MCP is denied and allowlisted", () => {
    const warnings: string[] = [];
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        mcp: { servers: { paperless: { command: "paperless-mcp" } } },
      },
      workspaceDir: process.cwd(),
      toolDenylist: ["bundle-mcp"],
    });

    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: declared,
      steps: [
        {
          policy: { allow: ["bundle-mcp"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (bundle-mcp). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("warns when denied MCP server namespace is allowlisted", () => {
    const warnings: string[] = [];
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        mcp: { servers: { paperless: { command: "paperless-mcp" } } },
      },
      workspaceDir: process.cwd(),
      toolDenylist: ["paperless__*"],
    });

    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: declared,
      steps: [
        {
          policy: { allow: ["paperless__*"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (paperless__*). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("warns when broad MCP server wildcard deny covers an allowlisted namespace", () => {
    const warnings: string[] = [];
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        mcp: { servers: { paperless: { command: "paperless-mcp" } } },
      },
      workspaceDir: process.cwd(),
      toolDenylist: ["paperless*"],
    });

    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: declared,
      steps: [
        {
          policy: { allow: ["paperless__*"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (paperless__*). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("does not warn for MCP server namespace allowlist when one exact server tool is denied", () => {
    const warnings: string[] = [];
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        mcp: { servers: { paperless: { command: "paperless-mcp" } } },
      },
      workspaceDir: process.cwd(),
      toolDenylist: ["paperless__delete"],
    });

    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: declared,
      steps: [
        {
          policy: { allow: ["paperless__*"], deny: ["paperless__delete"] },
          label: "tools",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([]);
  });

  test("warns when plugin group is denied and MCP server namespace is allowlisted", () => {
    const warnings: string[] = [];
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        mcp: { servers: { paperless: { command: "paperless-mcp" } } },
      },
      workspaceDir: process.cwd(),
      toolDenylist: ["group:plugins"],
    });

    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: declared,
      steps: [
        {
          policy: { allow: ["paperless__*"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (paperless__*). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("warns when denied duplicate-safe MCP server namespace is allowlisted", () => {
    const warnings: string[] = [];
    const declared = buildDeclaredToolAllowlistContext({
      config: {
        mcp: {
          servers: {
            "vigil harbor": { command: "vigil-mcp" },
            "vigil:harbor": { command: "vigil-alt-mcp" },
          },
        },
      },
      workspaceDir: process.cwd(),
      toolDenylist: ["vigil-harbor-2__*"],
    });

    expect(Array.from(declared?.mcpServerNames ?? [])).toEqual(["vigil-harbor"]);

    applyToolPolicyPipeline({
      tools: asPolicyTools([{ name: "exec" }]),
      toolMeta: () => undefined,
      warn: (msg) => warnings.push(msg),
      declaredToolAllowlist: declared,
      steps: [
        {
          policy: { allow: ["vigil-harbor__*", "vigil-harbor-2__*"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (vigil-harbor-2__*). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("dedupes identical unknown-allowlist warnings across repeated runs", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    const params = {
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["wat"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    };

    applyToolPolicyPipeline(params);
    applyToolPolicyPipeline(params);

    expect(warnings).toHaveLength(1);
  });

  test("bounds the warning dedupe cache so new warnings still surface", () => {
    // Warning dedupe is bounded so long-running agents do not grow unbounded
    // memory while still surfacing new unknown allowlist entries.
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];

    for (let i = 0; i < 257; i += 1) {
      applyToolPolicyPipeline({
        tools: asPolicyTools(tools),
        toolMeta: () => undefined,
        warn: (msg: string) => warnings.push(msg),
        steps: [
          {
            policy: { allow: [`unknown_${i}`] },
            label: "tools.profile (coding)",
            stripPluginOnlyAllowlist: true,
          },
        ],
      });
    }

    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["unknown_0"] },
          label: "tools.profile (coding)",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });

    expect(warnings).toHaveLength(258);
  });

  test("evicts the oldest warning when the dedupe cache is full", () => {
    const warnings: string[] = [];
    const tools = [{ name: "exec" }] as unknown as DummyTool[];

    for (let i = 0; i < 256; i += 1) {
      applyToolPolicyPipeline({
        tools: asPolicyTools(tools),
        toolMeta: () => undefined,
        warn: (msg: string) => warnings.push(msg),
        steps: [
          {
            policy: { allow: [`unknown_${i}`] },
            label: "tools.allow",
            stripPluginOnlyAllowlist: true,
          },
        ],
      });
    }

    warnings.length = 0;

    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        {
          policy: { allow: ["unknown_256"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: (msg: string) => warnings.push(msg),
      steps: [
        { policy: { allow: ["unknown_0"] }, label: "tools.allow", stripPluginOnlyAllowlist: true },
      ],
    });

    expect(warnings).toEqual([
      "tools: tools.allow allowlist contains unknown entries (unknown_256). These entries won't match any tool unless the plugin is enabled.",
      "tools: tools.allow allowlist contains unknown entries (unknown_0). These entries won't match any tool unless the plugin is enabled.",
    ]);
  });

  test("applies allowlist filtering when core tools are explicitly listed", () => {
    const tools = [{ name: "exec" }, { name: "process" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(filtered.map((t) => (t as unknown as DummyTool).name)).toEqual(["exec"]);
  });

  test("applies deny filtering after allow filtering", () => {
    const tools = [{ name: "exec" }, { name: "process" }] as unknown as DummyTool[];
    const filtered = applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec", "process"], deny: ["process"] },
          label: "tools.allow",
          stripPluginOnlyAllowlist: true,
        },
      ],
    });
    expect(filtered.map((t) => (t as unknown as DummyTool).name)).toEqual(["exec"]);
  });

  test("audits the policy rule that removes tools", () => {
    const tools = [
      { name: "exec" },
      { name: "browser" },
      { name: "write" },
      { name: "read" },
    ] as unknown as DummyTool[];

    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec", "read"] },
          label: "agent tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "tool policy removed 2 tool(s) via agent tools.allow: browser, write",
      {
        rule: "agent tools.allow",
        ruleKind: "allow",
        removedToolCount: 2,
        removedTools: ["browser", "write"],
        removedToolsTruncated: false,
      },
    );
    expect(toolPolicyAuditDebug).not.toHaveBeenCalled();
  });

  test("can lower removal audits for diagnostic-only policy probes", () => {
    const tools = [{ name: "exec" }, { name: "browser" }] as unknown as DummyTool[];

    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: () => {},
      auditLogLevel: "debug",
      steps: [
        {
          policy: { allow: ["exec"] },
          label: "doctor tools.profile (coding)",
        },
      ],
    });

    expect(toolPolicyAuditDebug).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via doctor tools.profile (coding): browser",
      {
        rule: "doctor tools.profile (coding)",
        ruleKind: "allow",
        removedToolCount: 1,
        removedTools: ["browser"],
        removedToolsTruncated: false,
      },
    );
    expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
  });

  test("audits deny removals with the deny config key", () => {
    const tools = [{ name: "exec" }, { name: "browser" }] as unknown as DummyTool[];

    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { deny: ["browser"] },
          label: "tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via tools.deny: browser; matched browser",
      {
        rule: "tools.deny",
        ruleKind: "deny",
        matchedRules: ["browser"],
        removedToolCount: 1,
        removedTools: ["browser"],
        removedToolsTruncated: false,
      },
    );
    expect(toolPolicyAuditDebug).not.toHaveBeenCalled();
  });

  test("splits mixed allow and deny policy audit entries by cause", () => {
    const tools = [
      { name: "exec" },
      { name: "browser" },
      { name: "write" },
    ] as unknown as DummyTool[];

    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec"], deny: ["browser"] },
          label: "agents.worker.tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via agents.worker.tools.deny: browser; matched browser",
      {
        rule: "agents.worker.tools.deny",
        ruleKind: "deny",
        matchedRules: ["browser"],
        removedToolCount: 1,
        removedTools: ["browser"],
        removedToolsTruncated: false,
      },
    );
    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via agents.worker.tools.allow: write",
      {
        rule: "agents.worker.tools.allow",
        ruleKind: "allow",
        removedToolCount: 1,
        removedTools: ["write"],
        removedToolsTruncated: false,
      },
    );
    expect(toolPolicyAuditDebug).not.toHaveBeenCalled();
  });

  test("does not audit policy steps that leave the tool surface unchanged", () => {
    const tools = [{ name: "exec" }] as unknown as DummyTool[];

    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["exec"] },
          label: "tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditDebug).not.toHaveBeenCalled();
    expect(toolPolicyAuditInfo).not.toHaveBeenCalled();
  });

  test("sanitizes audit labels and tool names before logging", () => {
    const tools = [{ name: "exec\nbad" }] as unknown as DummyTool[];

    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["read"] },
          label: "agents.worker\nbad.tools.allow",
        },
      ],
    });

    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      "tool policy removed 1 tool(s) via agents.worker\\nbad.tools.allow: exec\\nbad",
      {
        rule: "agents.worker\\nbad.tools.allow",
        ruleKind: "allow",
        removedToolCount: 1,
        removedTools: ["exec\\nbad"],
        removedToolsTruncated: false,
      },
    );
    expect(toolPolicyAuditDebug).not.toHaveBeenCalled();
  });

  test("truncates audit fields without splitting surrogate pairs", () => {
    const tools = [{ name: "exec" }] as unknown as DummyTool[];
    const labelPrefix = "a".repeat(159);

    applyToolPolicyPipeline({
      tools: asPolicyTools(tools),
      toolMeta: () => undefined,
      warn: () => {},
      steps: [
        {
          policy: { allow: ["read"] },
          label: `${labelPrefix}😀suffix`,
        },
      ],
    });

    const rule = `${labelPrefix}...`;
    expect(toolPolicyAuditInfo).toHaveBeenCalledWith(
      `tool policy removed 1 tool(s) via ${rule}: exec`,
      {
        rule,
        ruleKind: "allow",
        removedToolCount: 1,
        removedTools: ["exec"],
        removedToolsTruncated: false,
      },
    );
  });
});
