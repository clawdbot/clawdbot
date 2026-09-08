// Coverage for Tool Search control planning and allowlist accounting.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { buildToolSearchRunPlan } from "./attempt-tool-search-run-plan.js";

describe("buildToolSearchRunPlan", () => {
  it("keeps compact visible names separate from replay-safe names", () => {
    // Visible compacted tools can be narrower than replay-safe names needed for
    // existing transcript tool calls.
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "tool_search_code" }] as never,
      uncompactedTools: [
        { name: "tool_search_code" },
        { name: "exec" },
        { name: "fake_plugin_tool" },
      ] as never,
      clientTools: [
        {
          type: "function",
          function: {
            name: "client_pick_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      clientToolsCataloged: true,
      catalogToolCount: 2,
      controlsEnabled: true,
      explicitAllowlistSources: [{ entries: ["missing_tool"] }],
    });

    expect([...plan.visibleAllowedToolNames]).toEqual(["tool_search_code"]);
    expect([...plan.replayAllowedToolNames]).toEqual([
      "tool_search_code",
      "exec",
      "fake_plugin_tool",
      "client_pick_file",
    ]);
    expect(plan.liveAllowedToolNames).toBe(plan.visibleAllowedToolNames);
    expect([...plan.capabilityToolNames]).toEqual(["tool_search_code"]);
    expect(plan.hasCallableTools).toBe(true);
  });

  it("counts explicitly allowlisted client tools before they are cataloged later", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "tool_search_code" }] as never,
      uncompactedTools: [{ name: "tool_search_code" }] as never,
      clientTools: [
        {
          type: "function",
          function: {
            name: "client_pick_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      clientToolsCataloged: true,
      catalogToolCount: 0,
      controlsEnabled: true,
      explicitAllowlistSources: [{ entries: ["client_pick_file"] }],
    });

    expect(plan.hasCallableTools).toBe(true);
  });

  it("keeps code-mode control tools in replay-safe names", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "exec" }, { name: "wait" }] as never,
      uncompactedTools: [{ name: "fake_plugin_tool" }] as never,
      clientTools: [],
      clientToolsCataloged: true,
      catalogToolCount: 1,
      controlsEnabled: true,
      controlNames: ["exec", "wait"],
      explicitAllowlistSources: [{ entries: ["missing_tool"] }],
    });

    expect([...plan.visibleAllowedToolNames]).toEqual(["exec", "wait"]);
    expect([...plan.replayAllowedToolNames]).toEqual(["fake_plugin_tool", "exec", "wait"]);
    expect([...plan.capabilityToolNames]).toEqual(["exec", "wait"]);
    expect(plan.hasCallableTools).toBe(true);
  });

  it("carries native catalog capabilities without widening direct execution authority", () => {
    const tool = (name: string): AnyAgentTool => ({
      name,
      label: name,
      description: "Tool inventory fixture",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: undefined }),
    });
    const foreignTool = tool("sessions_yield");
    setPluginToolMeta(foreignTool, { pluginId: "bundle-mcp", optional: false });
    const catalogCapabilityTools = [
      ...["process", "sessions_spawn", "image_generate", "music_generate", "video_generate"].map(
        tool,
      ),
      foreignTool,
    ];
    const input = {
      visibleTools: [tool("exec"), tool("wait")],
      uncompactedTools: catalogCapabilityTools,
      catalogCapabilityTools,
      clientTools: [
        {
          type: "function" as const,
          function: { name: "subagents", parameters: { type: "object", properties: {} } },
        },
      ],
      clientToolsCataloged: true,
      catalogToolCount: catalogCapabilityTools.length,
      controlsEnabled: true,
      deferredToolsCallable: false,
      controlNames: ["exec", "wait"],
      explicitAllowlistSources: [],
    };
    const plan = buildToolSearchRunPlan(input);

    expect(plan.capabilityToolNames).toEqual(
      new Set([
        "exec",
        "wait",
        "process",
        "sessions_spawn",
        "image_generate",
        "music_generate",
        "video_generate",
      ]),
    );
    expect([...plan.visibleAllowedToolNames]).toEqual(["exec", "wait"]);
    expect([...plan.liveAllowedToolNames]).toEqual(["exec", "wait"]);
    expect(plan.replayAllowedToolNames.has("sessions_spawn")).toBe(true);
  });

  it("does not let unrelated client tools mask a bad explicit allowlist", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "tool_search_code" }] as never,
      uncompactedTools: [{ name: "tool_search_code" }] as never,
      clientTools: [
        {
          type: "function",
          function: {
            name: "client_pick_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      clientToolsCataloged: true,
      catalogToolCount: 0,
      controlsEnabled: true,
      explicitAllowlistSources: [{ entries: ["missing_tool"] }],
    });

    expect(plan.hasCallableTools).toBe(false);
  });

  it("keeps explicitly requested Tool Search controls callable", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "tool_search_code" }] as never,
      uncompactedTools: [{ name: "tool_search_code" }] as never,
      clientToolsCataloged: true,
      catalogToolCount: 0,
      controlsEnabled: true,
      explicitAllowlistSources: [{ entries: ["tool_search_code"] }],
    });

    expect(plan.hasCallableTools).toBe(true);
  });

  it("keeps uncataloged directory-mode client tools visible", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [
        { name: "tool_search" },
        { name: "tool_describe" },
        { name: "tool_call" },
      ] as never,
      uncompactedTools: [{ name: "tool_search_code" }, { name: "fake_plugin_tool" }] as never,
      clientTools: [
        {
          type: "function",
          function: {
            name: "client_pick_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      clientToolsCataloged: false,
      catalogToolCount: 1,
      controlsEnabled: true,
      deferredToolsCallable: true,
      controlNames: ["tool_search", "tool_describe", "tool_call"],
      explicitAllowlistSources: [{ entries: ["missing_tool"] }],
    });

    expect([...plan.visibleAllowedToolNames]).toEqual([
      "tool_search",
      "tool_describe",
      "tool_call",
      "client_pick_file",
    ]);
    expect([...plan.liveAllowedToolNames]).toEqual([
      "fake_plugin_tool",
      "tool_search",
      "tool_describe",
      "tool_call",
      "client_pick_file",
    ]);
    expect([...plan.capabilityToolNames]).toEqual(["fake_plugin_tool"]);
    expect(plan.hasCallableTools).toBe(true);
  });

  it("does not let visible directory client tools mask a bad explicit allowlist", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [
        { name: "tool_search" },
        { name: "tool_describe" },
        { name: "tool_call" },
      ] as never,
      uncompactedTools: [],
      clientTools: [
        {
          type: "function",
          function: {
            name: "client_pick_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      clientToolsCataloged: false,
      catalogToolCount: 0,
      controlsEnabled: true,
      deferredToolsCallable: true,
      controlNames: ["tool_search", "tool_describe", "tool_call"],
      explicitAllowlistSources: [{ entries: ["missing_tool"] }],
    });

    expect([...plan.visibleAllowedToolNames]).toContain("client_pick_file");
    expect(plan.hasCallableTools).toBe(false);
  });

  it("counts explicitly allowlisted visible directory client tools", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [
        { name: "tool_search" },
        { name: "tool_describe" },
        { name: "tool_call" },
      ] as never,
      uncompactedTools: [],
      clientTools: [
        {
          type: "function",
          function: {
            name: "client_pick_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      clientToolsCataloged: false,
      catalogToolCount: 0,
      controlsEnabled: true,
      deferredToolsCallable: true,
      controlNames: ["tool_search", "tool_describe", "tool_call"],
      explicitAllowlistSources: [{ entries: ["client_pick_file"] }],
    });

    expect(plan.hasCallableTools).toBe(true);
  });

  it("counts wildcard-allowlisted visible directory client tools", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [
        { name: "tool_search" },
        { name: "tool_describe" },
        { name: "tool_call" },
      ] as never,
      uncompactedTools: [],
      clientTools: [
        {
          type: "function",
          function: {
            name: "client_pick_file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      clientToolsCataloged: false,
      catalogToolCount: 0,
      controlsEnabled: true,
      deferredToolsCallable: true,
      controlNames: ["tool_search", "tool_describe", "tool_call"],
      explicitAllowlistSources: [{ entries: ["client_*"] }],
    });

    expect(plan.hasCallableTools).toBe(true);
  });

  it("keeps client names out of OpenClaw capability guidance", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "fake_plugin_tool" }] as never,
      uncompactedTools: [{ name: "fake_plugin_tool" }] as never,
      clientTools: [
        {
          type: "function",
          function: {
            name: "sessions_spawn",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      clientToolsCataloged: false,
      catalogToolCount: 0,
      controlsEnabled: false,
      explicitAllowlistSources: [],
    });

    expect([...plan.liveAllowedToolNames]).toEqual(["fake_plugin_tool", "sessions_spawn"]);
    expect([...plan.capabilityToolNames]).toEqual(["fake_plugin_tool"]);
  });

  it("keeps MCP names out of OpenClaw capability guidance", () => {
    const mcpTool = { name: "sessions_spawn" };
    setPluginToolMeta(mcpTool as never, {
      pluginId: "bundle-mcp",
      optional: false,
    });
    const plan = buildToolSearchRunPlan({
      visibleTools: [{ name: "tool_search" }] as never,
      uncompactedTools: [{ name: "fake_plugin_tool" }, mcpTool] as never,
      clientToolsCataloged: false,
      catalogToolCount: 2,
      controlsEnabled: true,
      deferredToolsCallable: true,
      controlNames: ["tool_search"],
      explicitAllowlistSources: [],
    });

    expect([...plan.liveAllowedToolNames]).toEqual([
      "fake_plugin_tool",
      "sessions_spawn",
      "tool_search",
    ]);
    expect([...plan.capabilityToolNames]).toEqual(["fake_plugin_tool"]);
  });

  it("keeps ambiguous deferred directory names out of live calls", () => {
    const plan = buildToolSearchRunPlan({
      visibleTools: [
        { name: "tool_search" },
        { name: "tool_describe" },
        { name: "tool_call" },
      ] as never,
      uncompactedTools: [
        { name: "fake_plugin_tool" },
        { name: "sessions_spawn" },
        { name: "sessions_spawn" },
      ] as never,
      clientToolsCataloged: false,
      catalogToolCount: 3,
      controlsEnabled: true,
      deferredToolsCallable: true,
      controlNames: ["tool_search", "tool_describe", "tool_call"],
      explicitAllowlistSources: [],
    });

    expect([...plan.liveAllowedToolNames]).toEqual([
      "fake_plugin_tool",
      "tool_search",
      "tool_describe",
      "tool_call",
    ]);
    expect([...plan.replayAllowedToolNames]).toContain("sessions_spawn");
  });
});
