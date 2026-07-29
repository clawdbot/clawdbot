// Coverage for Tool Search control planning and allowlist accounting.
import { describe, expect, it } from "vitest";
import { setPluginToolMeta } from "../../../plugins/tools.js";
import { buildToolSearchRunPlan } from "./attempt.tool-search-run-plan.js";

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
    expect(plan.emptyAllowlistCallableNames).toEqual(["tool-search:0", "tool-search:1"]);
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

    expect(plan.emptyAllowlistCallableNames).toEqual(["tool-search-client:client_pick_file"]);
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
    expect(plan.emptyAllowlistCallableNames).toEqual(["tool-search:0"]);
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

    expect(plan.emptyAllowlistCallableNames).toEqual([]);
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

    expect(plan.emptyAllowlistCallableNames).toEqual(["tool_search_code"]);
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
    expect(plan.emptyAllowlistCallableNames).toEqual(["tool-search:0"]);
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
    expect(plan.emptyAllowlistCallableNames).toEqual([]);
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

    expect(plan.emptyAllowlistCallableNames).toEqual(["client_pick_file"]);
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

    expect(plan.emptyAllowlistCallableNames).toEqual(["client_pick_file"]);
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
