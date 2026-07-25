import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runWithAgentRingZeroTools } from "../agent-tools.ring-zero-context.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "../tool-search.js";
import { testing } from "../tool-search.test-support.js";
import { createAgentHarnessToolSurfaceRuntime } from "./tool-surface-bridge.js";

function tools(names: string[]) {
  return names.map(createStubTool);
}

function createRuntime(config: OpenClawConfig) {
  return createAgentHarnessToolSurfaceRuntime({
    config,
    executeTool: async () => ({ content: [], details: {} }),
    modelToolsEnabled: true,
  });
}

describe("createAgentHarnessToolSurfaceRuntime", () => {
  it("suppresses catalog controls for a host-scoped ring-zero run", () => {
    const openclaw = {
      ...createStubTool("openclaw"),
      catalogMode: "direct-only" as const,
    };

    runWithAgentRingZeroTools([openclaw], () => {
      const runtime = createAgentHarnessToolSurfaceRuntime({
        config: { tools: { toolSearch: true } },
        executeTool: async () => ({ content: [], details: {} }),
        modelToolsEnabled: true,
        runtimeToolAllowlist: ["openclaw"],
        toolsAllow: ["openclaw"],
      });

      expect(runtime.codeModeControlsEnabled).toBe(false);
      expect(runtime.toolSearchControlsEnabled).toBe(false);
      expect(runtime.includeToolSearchControls).toBe(false);
      expect(runtime.runtimeToolAllowlist).toEqual(["openclaw"]);
      expect(runtime.compactTools([openclaw]).tools).toEqual([openclaw]);
      runtime.cleanup();
    });
  });

  it("filters raw SDK tools but does not refilter prepared constructor output", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: true } } },
      tools: { alsoAllow: ["image_generate"], toolSearch: { enabled: false } },
    };
    const runtime = createRuntime(config);

    expect(
      runtime
        .compactTools(tools(["read", "browser", "image_generate"]))
        .tools.map((tool) => tool.name),
    ).toEqual(["read", "image_generate"]);
    expect(
      runtime
        .compactTools(tools(["read", "browser"]), { localModelLeanApplied: true })
        .tools.map((tool) => tool.name),
    ).toEqual(["read", "browser"]);
    runtime.cleanup();
  });

  it("keeps exec direct in lean structured Tool Search mode", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { experimental: { localModelLean: true } } },
    };
    const runtime = createRuntime(config);

    expect(
      runtime
        .compactTools(
          tools([
            TOOL_SEARCH_RAW_TOOL_NAME,
            TOOL_DESCRIBE_RAW_TOOL_NAME,
            TOOL_CALL_RAW_TOOL_NAME,
            "exec",
            "read",
          ]),
        )
        .tools.map((tool) => tool.name),
    ).toEqual([
      TOOL_SEARCH_RAW_TOOL_NAME,
      TOOL_DESCRIBE_RAW_TOOL_NAME,
      TOOL_CALL_RAW_TOOL_NAME,
      "exec",
    ]);
    runtime.cleanup();
  });

  it("preserves explicit code-mode compaction for lean runs", () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    try {
      const config: OpenClawConfig = {
        agents: { defaults: { experimental: { localModelLean: true } } },
        tools: { toolSearch: { mode: "code" } },
      };
      const runtime = createRuntime(config);

      expect(
        runtime
          .compactTools(tools([TOOL_SEARCH_CODE_MODE_TOOL_NAME, "exec", "read"]))
          .tools.map((tool) => tool.name),
      ).toEqual([TOOL_SEARCH_CODE_MODE_TOOL_NAME]);
      runtime.cleanup();
    } finally {
      testing.setToolSearchCodeModeSupportedForTest(undefined);
    }
  });
});
