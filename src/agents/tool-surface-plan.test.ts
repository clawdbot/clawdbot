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
    {
      name: "proposal-only skill workshop run",
      overrides: { skillWorkshopProposalOnly: true },
    },
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
