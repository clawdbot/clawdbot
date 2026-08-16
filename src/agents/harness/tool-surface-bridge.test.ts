import { describe, expect, it } from "vitest";
import { migratePersistedImplicitMainRoster } from "../../config/legacy.roster.js";
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
import { createAgentHarnessToolSurfaceRuntimeCore as createAgentHarnessToolSurfaceRuntimeBase } from "./tool-surface-bridge.js";

function createAgentHarnessToolSurfaceRuntime(
  params: Parameters<typeof createAgentHarnessToolSurfaceRuntimeBase>[0],
): ReturnType<typeof createAgentHarnessToolSurfaceRuntimeBase> {
  return createAgentHarnessToolSurfaceRuntimeBase({
    ...params,
    config: migratePersistedImplicitMainRoster(params.config).config as OpenClawConfig,
  });
}

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

  it("keeps proposal-only skill workshop runs on the raw harness tool surface", () => {
    const rawTools = tools(["skill_workshop"]);
    const runtime = createAgentHarnessToolSurfaceRuntime({
      config: { tools: { codeMode: true, toolSearch: true } },
      executeTool: async () => ({ content: [], details: {} }),
      modelToolsEnabled: true,
      skillWorkshopProposalOnly: true,
      toolsAllow: ["skill_workshop"],
    });

    try {
      expect(runtime.codeModeControlsEnabled).toBe(false);
      expect(runtime.toolSearchControlsEnabled).toBe(false);
      expect(runtime.compactTools(rawTools).tools).toEqual(rawTools);
      expect(runtime.compactTools(rawTools).tools.map((tool) => tool.name)).not.toContain("exec");
      expect(runtime.compactTools(rawTools).tools.map((tool) => tool.name)).not.toContain("wait");
    } finally {
      runtime.cleanup();
    }
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
      "read",
    ]);
    runtime.cleanup();
  });

  it("keeps directory tool schemas stable across unrelated user prompts", () => {
    const config: OpenClawConfig = {
      tools: { toolSearch: { enabled: true, mode: "directory" } },
    };
    const availableTools = tools([
      TOOL_SEARCH_RAW_TOOL_NAME,
      TOOL_DESCRIBE_RAW_TOOL_NAME,
      TOOL_CALL_RAW_TOOL_NAME,
      "read",
      "web_search",
      "memory_search",
      "message",
    ]);
    const createPromptRuntime = (prompt: string) =>
      createAgentHarnessToolSurfaceRuntime({
        config,
        executeTool: async () => ({ content: [], details: {} }),
        modelToolsEnabled: true,
        prompt,
      });
    const first = createPromptRuntime("search today's latest news");
    const second = createPromptRuntime("remember what we decided yesterday");

    try {
      const expected = [
        TOOL_SEARCH_RAW_TOOL_NAME,
        TOOL_DESCRIBE_RAW_TOOL_NAME,
        TOOL_CALL_RAW_TOOL_NAME,
        "read",
      ];
      expect(first.compactTools(availableTools).tools.map((tool) => tool.name)).toEqual(expected);
      expect(second.compactTools(availableTools).tools.map((tool) => tool.name)).toEqual(expected);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  it("keeps policy-required message delivery directly visible in structured mode", () => {
    const runtime = createAgentHarnessToolSurfaceRuntime({
      config: { tools: { toolSearch: { enabled: true, mode: "tools" } } },
      executeTool: async () => ({ content: [], details: {} }),
      sourceReplyDeliveryMode: "message_tool_only",
      modelToolsEnabled: true,
    });

    try {
      expect(
        runtime
          .compactTools(
            tools([
              TOOL_SEARCH_RAW_TOOL_NAME,
              TOOL_DESCRIBE_RAW_TOOL_NAME,
              TOOL_CALL_RAW_TOOL_NAME,
              "web_search",
              "message",
            ]),
          )
          .tools.map((tool) => tool.name),
      ).toEqual([
        TOOL_SEARCH_RAW_TOOL_NAME,
        TOOL_DESCRIBE_RAW_TOOL_NAME,
        TOOL_CALL_RAW_TOOL_NAME,
        "message",
      ]);
    } finally {
      runtime.cleanup();
    }
  });

  it.each([
    { name: "message-only delivery", sourceReplyDeliveryMode: "message_tool_only" as const },
    { name: "forced message delivery", forceMessageTool: true },
  ])("keeps $name directly visible in Code Mode", (delivery) => {
    const runtime = createAgentHarnessToolSurfaceRuntime({
      config: { tools: { codeMode: true } },
      executeTool: async () => ({ content: [], details: {} }),
      ...delivery,
      modelToolsEnabled: true,
    });

    try {
      expect(
        runtime.compactTools(tools(["web_search", "message"])).tools.map((tool) => tool.name),
      ).toEqual(["exec", "wait", "message"]);
    } finally {
      runtime.cleanup();
    }
  });

  it("keeps policy-required message delivery directly visible in directory mode", () => {
    const runtime = createAgentHarnessToolSurfaceRuntime({
      config: { tools: { toolSearch: { enabled: true, mode: "directory" } } },
      executeTool: async () => ({ content: [], details: {} }),
      forceMessageTool: true,
      modelToolsEnabled: true,
      prompt: "search today's latest news",
    });

    try {
      expect(
        runtime
          .compactTools(
            tools([
              TOOL_SEARCH_RAW_TOOL_NAME,
              TOOL_DESCRIBE_RAW_TOOL_NAME,
              TOOL_CALL_RAW_TOOL_NAME,
              "web_search",
              "message",
            ]),
          )
          .tools.map((tool) => tool.name),
      ).toEqual([
        TOOL_SEARCH_RAW_TOOL_NAME,
        TOOL_DESCRIBE_RAW_TOOL_NAME,
        TOOL_CALL_RAW_TOOL_NAME,
        "message",
      ]);
    } finally {
      runtime.cleanup();
    }
  });

  it.each([
    {
      name: "auto engages a catalog-preferred model",
      codeMode: "auto",
      codeModeTier: "preferred",
      engaged: true,
    },
    {
      name: "auto falls back to tool search for an unflagged model",
      codeMode: "auto",
      codeModeTier: undefined,
      engaged: false,
    },
    {
      name: "true engages an unflagged model",
      codeMode: true,
      codeModeTier: undefined,
      engaged: true,
    },
    {
      name: "false never engages a preferred model",
      codeMode: false,
      codeModeTier: "preferred",
      engaged: false,
    },
  ] as const)("$name", ({ codeMode, codeModeTier, engaged }) => {
    const runtime = createAgentHarnessToolSurfaceRuntime({
      config: { tools: { codeMode, toolSearch: true } },
      executeTool: async () => ({ content: [], details: {} }),
      model: codeModeTier ? { compat: { codeMode: codeModeTier } } : { compat: {} },
      modelToolsEnabled: true,
    });

    try {
      expect(runtime.codeModeControlsEnabled).toBe(engaged);
      // Code mode and tool search stay mutually exclusive for one run.
      expect(runtime.toolSearchControlsEnabled).toBe(!engaged);
    } finally {
      runtime.cleanup();
    }
  });

  it("preserves explicit code-mode compaction for lean runs", () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    try {
      const config: OpenClawConfig = {
        agents: { defaults: { experimental: { localModelLean: true } } },
        tools: { toolSearch: { mode: "code" } },
      };
      const runtime = createRuntime(config);

      // Compaction still applies to non-core tools; core coding tools stay visible.
      expect(
        runtime
          .compactTools(tools([TOOL_SEARCH_CODE_MODE_TOOL_NAME, "exec", "read"]))
          .tools.map((tool) => tool.name),
      ).toEqual([TOOL_SEARCH_CODE_MODE_TOOL_NAME, "exec", "read"]);
      runtime.cleanup();
    } finally {
      testing.setToolSearchCodeModeSupportedForTest(undefined);
    }
  });
});
