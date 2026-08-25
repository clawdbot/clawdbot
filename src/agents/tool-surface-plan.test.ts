import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import { createCodeModeTools } from "./code-mode.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import {
  createToolSearchCatalogRef,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogToolExecutor,
} from "./tool-search.js";
import { applyAgentToolSurfaceCatalog, resolveAgentToolSurfacePlan } from "./tool-surface-plan.js";

// Params type stays module-local in production; derive it so the test cannot
// keep a public export alive that no production caller needs.
type AgentToolSurfacePlanParams = Parameters<typeof resolveAgentToolSurfacePlan>[0];

const controlsEnabledConfig: OpenClawConfig = {
  tools: { codeMode: true, toolSearch: true },
};
const basePlanParams: AgentToolSurfacePlanParams = {
  config: controlsEnabledConfig,
  forceDirectMessageTool: false,
  toolsEnabled: true,
  isRawModelRun: false,
};

describe("resolveAgentToolSurfacePlan", () => {
  it.each([
    { name: "model tools disabled", overrides: { toolsEnabled: false } },
    { name: "tools disabled for the run", overrides: { disableTools: true } },
    { name: "raw model run", overrides: { isRawModelRun: true } },
    { name: "host-scoped ring-zero run", overrides: {}, ringZero: true },
    { name: "empty explicit allowlist", overrides: { toolsAllow: [] } },
  ] satisfies Array<{
    name: string;
    overrides: Partial<AgentToolSurfacePlanParams>;
    ringZero?: boolean;
  }>)("suppresses both controls for $name", ({ overrides, ringZero }) => {
    const resolve = () => resolveAgentToolSurfacePlan({ ...basePlanParams, ...overrides });
    const plan = ringZero
      ? runWithAgentRingZeroTools([createStubTool("openclaw")], resolve)
      : resolve();

    expect(plan.codeModeControlsEnabled).toBe(false);
    expect(plan.toolSearchControlsEnabled).toBe(false);
  });

  it.each([
    {
      name: "code mode wins when engaged",
      config: { tools: { codeMode: true, toolSearch: true } },
      expected: { codeMode: true, toolSearch: false },
    },
    {
      name: "tool search engages when code mode does not",
      config: { tools: { codeMode: false, toolSearch: true } },
      expected: { codeMode: false, toolSearch: true },
    },
  ] satisfies Array<{
    name: string;
    config: OpenClawConfig;
    expected: { codeMode: boolean; toolSearch: boolean };
  }>)("keeps controls mutually exclusive: $name", ({ config, expected }) => {
    const plan = resolveAgentToolSurfacePlan({ ...basePlanParams, config });

    expect(plan.codeModeControlsEnabled).toBe(expected.codeMode);
    expect(plan.toolSearchControlsEnabled).toBe(expected.toolSearch);
    expect(plan.codeModeControlsEnabled && plan.toolSearchControlsEnabled).toBe(false);
  });

  it("preserves Code Mode controls for a checkpoint-proven restart recovery", () => {
    const config: OpenClawConfig = {
      tools: { codeMode: false, toolSearch: true },
    };
    const plan = resolveAgentToolSurfacePlan({
      ...basePlanParams,
      config,
      forceCodeModeControls: true,
    });

    expect(plan.codeModeControlsEnabled).toBe(true);
    expect(plan.toolSearchControlsEnabled).toBe(false);
  });

  it.each([
    {
      name: "Code Mode",
      config: { tools: { codeMode: true, toolSearch: true } },
    },
    {
      name: "Code Mode with a normalized message allowlist",
      config: { tools: { codeMode: true, toolSearch: true } },
      toolsAllow: [" MESSAGE "],
    },
    {
      name: "Tool Search",
      config: { tools: { codeMode: false, toolSearch: true } },
    },
    {
      name: "checkpoint-proven Code Mode recovery",
      config: { tools: { codeMode: false, toolSearch: true } },
      forceCodeModeControls: true,
    },
  ] satisfies Array<{
    name: string;
    config: OpenClawConfig;
    toolsAllow?: string[];
    forceCodeModeControls?: boolean;
  }>)("does not add $name controls to a completion-private message-only run", (run) => {
    const plan = resolveAgentToolSurfacePlan({
      ...basePlanParams,
      config: run.config,
      forceDirectMessageTool: true,
      toolsAllow: run.toolsAllow ?? ["message"],
      forceCodeModeControls: run.forceCodeModeControls,
    });
    const result = applyAgentToolSurfaceCatalog({
      tools: [createStubTool("message")],
      config: run.config,
      toolSearchRuntimeConfig: plan.toolSearchRuntimeConfig,
      codeModeControlsEnabled: plan.codeModeControlsEnabled,
      toolSearchConfig: plan.toolSearchConfig,
      forceDirectMessageTool: true,
      catalogRef: createToolSearchCatalogRef(),
    });

    expect(plan.codeModeControlsEnabled).toBe(false);
    expect(plan.toolSearchControlsEnabled).toBe(false);
    expect(result.tools.map((tool) => tool.name)).toEqual(["message"]);
  });

  it.each([
    { name: "no runtime allowlist", toolsAllow: undefined },
    { name: "a wildcard runtime allowlist", toolsAllow: ["*"] },
    { name: "a wildcard alongside an explicit message", toolsAllow: ["message", "*"] },
    { name: "an ordinary finite runtime allowlist", toolsAllow: ["read", "write"] },
    { name: "a message alongside another allowed tool", toolsAllow: ["message", "read"] },
  ])("preserves normal Code Mode message turns with $name", ({ toolsAllow }) => {
    const plan = resolveAgentToolSurfacePlan({
      ...basePlanParams,
      forceDirectMessageTool: true,
      toolsAllow,
    });

    expect(plan.codeModeControlsEnabled).toBe(true);
    expect(plan.toolSearchControlsEnabled).toBe(false);
  });

  it.each([
    {
      name: "Tool Search",
      config: { tools: { codeMode: false, toolSearch: true } },
      expected: { codeMode: false, toolSearch: true },
    },
    {
      name: "checkpoint-proven Code Mode recovery",
      config: { tools: { codeMode: false, toolSearch: true } },
      forceCodeModeControls: true,
      expected: { codeMode: true, toolSearch: false },
    },
    {
      name: "a message-only run without a forced direct reply",
      config: { tools: { codeMode: true, toolSearch: true } },
      toolsAllow: ["message"],
      expected: { codeMode: true, toolSearch: false },
    },
  ] satisfies Array<{
    name: string;
    config: OpenClawConfig;
    toolsAllow?: string[];
    forceCodeModeControls?: boolean;
    expected: { codeMode: boolean; toolSearch: boolean };
  }>)("preserves $name for ordinary finite allowlists", (run) => {
    const plan = resolveAgentToolSurfacePlan({
      ...basePlanParams,
      config: run.config,
      toolsAllow: run.toolsAllow ?? ["read", "write"],
      forceCodeModeControls: run.forceCodeModeControls,
    });

    expect(plan.codeModeControlsEnabled).toBe(run.expected.codeMode);
    expect(plan.toolSearchControlsEnabled).toBe(run.expected.toolSearch);
  });
});

describe("applyAgentToolSurfaceCatalog", () => {
  const executeTool: ToolSearchCatalogToolExecutor = async () => ({ content: [], details: {} });

  it("uses the code-mode catalog when code-mode controls are enabled", () => {
    const config: OpenClawConfig = {
      tools: { codeMode: true, toolSearch: { enabled: true, mode: "directory" } },
    };
    const plan = resolveAgentToolSurfacePlan({ ...basePlanParams, config });
    const catalogRef = createToolSearchCatalogRef();
    const result = applyAgentToolSurfaceCatalog({
      tools: [
        ...createCodeModeTools({ config, catalogRef, executeTool }),
        createStubTool("hidden_target"),
      ],
      config,
      toolSearchRuntimeConfig: plan.toolSearchRuntimeConfig,
      codeModeControlsEnabled: plan.codeModeControlsEnabled,
      toolSearchConfig: plan.toolSearchConfig,
      forceDirectMessageTool: false,
      catalogRef,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(result.catalogToolCount).toBe(1);
  });

  it("forces the Code Mode catalog for a checkpoint-proven restart recovery", () => {
    const config: OpenClawConfig = {
      tools: { codeMode: false, toolSearch: { enabled: true, mode: "directory" } },
    };
    const plan = resolveAgentToolSurfacePlan({
      ...basePlanParams,
      config,
      forceCodeModeControls: true,
    });
    const catalogRef = createToolSearchCatalogRef();
    const result = applyAgentToolSurfaceCatalog({
      tools: [
        ...createCodeModeTools({ config, catalogRef, executeTool }),
        createStubTool("hidden_target"),
      ],
      config,
      toolSearchRuntimeConfig: plan.toolSearchRuntimeConfig,
      codeModeControlsEnabled: plan.codeModeControlsEnabled,
      toolSearchConfig: plan.toolSearchConfig,
      forceDirectMessageTool: false,
      forceCodeModeControls: true,
      catalogRef,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(result.catalogToolCount).toBe(1);
  });

  it("uses the schema-directory catalog in directory mode", () => {
    const config: OpenClawConfig = {
      tools: { codeMode: false, toolSearch: { enabled: true, mode: "directory" } },
    };
    const plan = resolveAgentToolSurfacePlan({ ...basePlanParams, config });
    const result = applyAgentToolSurfaceCatalog({
      tools: [createStubTool("uncataloged_without_directory_controls")],
      config,
      toolSearchRuntimeConfig: plan.toolSearchRuntimeConfig,
      codeModeControlsEnabled: plan.codeModeControlsEnabled,
      toolSearchConfig: plan.toolSearchConfig,
      forceDirectMessageTool: false,
      catalogRef: createToolSearchCatalogRef(),
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "uncataloged_without_directory_controls",
    ]);
    expect(result.compacted).toBe(false);
  });

  it("uses the tool-search catalog outside directory mode", () => {
    const config: OpenClawConfig = {
      tools: { codeMode: false, toolSearch: { enabled: true, mode: "tools" } },
    };
    const plan = resolveAgentToolSurfacePlan({ ...basePlanParams, config });
    const result = applyAgentToolSurfaceCatalog({
      tools: [createStubTool(TOOL_SEARCH_RAW_TOOL_NAME), createStubTool("hidden_target")],
      config,
      toolSearchRuntimeConfig: plan.toolSearchRuntimeConfig,
      codeModeControlsEnabled: plan.codeModeControlsEnabled,
      toolSearchConfig: plan.toolSearchConfig,
      forceDirectMessageTool: false,
      catalogRef: createToolSearchCatalogRef(),
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([TOOL_SEARCH_RAW_TOOL_NAME]);
    expect(result.catalogToolCount).toBe(1);
  });
});
