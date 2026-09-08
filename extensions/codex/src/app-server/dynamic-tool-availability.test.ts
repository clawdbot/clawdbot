import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { describe, expect, it } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { parseCodexNativeToolCatalog } from "./native-tool-catalog.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

function createCollectorTools(swarm?: false) {
  return createOpenClawCodingTools({
    sessionKey: "agent:main:main",
    runId: "parent",
    config: {
      agents: { entries: { main: { default: true } } },
      tools: { profile: "coding", ...(swarm === false ? { swarm: false } : {}) },
    },
  }).filter((tool) => tool.name === "sessions_spawn" || tool.name === "agents_wait");
}

describe("Codex collector availability", () => {
  it.each(["direct", "searchable"] as const)(
    "keeps native catalogs frozen across the default-on upgrade with %s loading",
    async (loading) => {
      const legacy = createCodexDynamicToolBridge({
        tools: createCollectorTools(false),
        loading,
        signal: new AbortController().signal,
      });
      const nativeFingerprint = codexDynamicToolsFingerprint(legacy.specs);
      const nativeSpecs = parseCodexNativeToolCatalog(
        { id: "thread", dynamic_tools: legacy.specs },
        "thread",
        nativeFingerprint,
      );
      const legacyFunctions = flattenCodexDynamicToolFunctions(nativeSpecs);
      expect(legacyFunctions.map((tool) => tool.name)).toEqual(["sessions_spawn"]);
      expect(legacyFunctions[0]?.inputSchema).not.toHaveProperty("properties.collect");

      const currentTools = createCollectorTools();
      expect(currentTools.find((tool) => tool.name === "agents_wait")).toBeDefined();
      const resumed = createCodexDynamicToolBridge({
        tools: currentTools,
        registeredTools: [],
        registeredSpecs: nativeSpecs,
        loading,
        signal: new AbortController().signal,
      });
      expect(resumed.specs).toEqual(nativeSpecs);
      expect(codexDynamicToolsFingerprint(resumed.specs)).toBe(nativeFingerprint);
      expect(resumed.availableSpecs).toEqual(nativeSpecs);
      expect(resumed.availableTools.map((tool) => tool.name)).toEqual(["sessions_spawn"]);
      const resumedSpawn = resumed.availableTools.find((tool) => tool.name === "sessions_spawn");
      expect(resumedSpawn?.parameters).not.toHaveProperty("properties.collect");
      expect(resumedSpawn?.parameters).toHaveProperty("properties.fastMode");
      expect(resumedSpawn?.description).not.toContain("collect=true");
      const rejected = await resumed.handleToolCall({
        callId: "uncollectable-upgrade",
        threadId: "thread",
        turnId: "turn",
        tool: "sessions_spawn",
        arguments: { task: "inspect", collect: true },
      });
      expect(rejected.success).toBe(false);
      expect(JSON.stringify(rejected.contentItems)).toMatch(
        /Collector results are unavailable|Invalid arguments/,
      );

      // A fresh native registration uses new factory instances and the omitted Swarm default.
      const tools = createCollectorTools();
      const initial = createCodexDynamicToolBridge({
        tools,
        registeredTools: tools,
        loading,
        signal: new AbortController().signal,
      });
      const inherited = createCodexDynamicToolBridge({
        tools,
        registeredTools: [],
        registeredSpecs: initial.specs,
        loading,
        signal: new AbortController().signal,
      });
      expect(codexDynamicToolsFingerprint(initial.specs)).not.toBe(nativeFingerprint);
      expect(inherited.specs).toEqual(initial.specs);
      for (const bridge of [initial, inherited]) {
        const spawn = bridge.availableTools.find((tool) => tool.name === "sessions_spawn");
        const functions = flattenCodexDynamicToolFunctions(bridge.specs);
        const projectedSpawn = functions.find((tool) => tool.name === "sessions_spawn");
        for (const field of ["collect", "outputSchema", "groupId"]) {
          expect(spawn?.parameters).toHaveProperty(`properties.${field}`);
          expect(projectedSpawn?.inputSchema).toHaveProperty(`properties.${field}`);
        }
        expect(spawn?.description).toContain("await with agents_wait");
        expect(functions.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["sessions_spawn", "agents_wait"]),
        );
      }
    },
  );

  it.each([
    "missing",
    "quarantined",
    "lookalike",
    "registered-surface",
    "unregistered",
    "registration-quarantined",
  ] as const)("narrows the actual spawn definition when the reader is %s", async (kind) => {
    const tools = createCollectorTools();
    const spawn = tools.find((tool) => tool.name === "sessions_spawn")!;
    const reader = tools.find((tool) => tool.name === "agents_wait")!;
    expect(spawn.parameters).toHaveProperty("properties.collect");
    const initial = createCodexDynamicToolBridge({
      tools,
      loading: "direct",
      signal: new AbortController().signal,
    });
    const registeredSpecs = initial.specs.filter(
      (spec) => spec.type === "function" && spec.name === "sessions_spawn",
    );
    if (kind === "quarantined") {
      reader.parameters = { type: "array", items: { type: "string" } };
    }
    const currentTools =
      kind === "missing" ? [spawn] : kind === "lookalike" ? [spawn, { ...reader }] : tools;
    const registeredTools =
      kind === "unregistered"
        ? [spawn]
        : kind === "registration-quarantined"
          ? [spawn, { ...reader, parameters: { type: "array", items: { type: "string" } } }]
          : undefined;
    const bridge = createCodexDynamicToolBridge({
      tools: currentTools,
      registeredTools,
      loading: "direct",
      signal: new AbortController().signal,
      ...(kind === "registered-surface" ? { registeredSpecs } : {}),
    });
    const executable = bridge.availableTools.find((tool) => tool.name === "sessions_spawn");
    expect(executable?.parameters).not.toHaveProperty("properties.collect");
    expect(executable?.parameters).toHaveProperty("properties.fastMode");
    expect(executable?.description).not.toContain("collect=true");
    if (kind === "registered-surface") {
      expect(bridge.specs).toEqual(registeredSpecs);
      expect(codexDynamicToolsFingerprint(bridge.specs)).toBe(
        codexDynamicToolsFingerprint(registeredSpecs),
      );
      expect(bridge.availableSpecs).toEqual(registeredSpecs);
    } else {
      for (const specs of [bridge.availableSpecs, bridge.specs]) {
        const spec = flattenCodexDynamicToolFunctions(specs).find(
          (tool) => tool.name === "sessions_spawn",
        );
        expect(spec?.inputSchema).not.toHaveProperty("properties.collect");
        expect(spec?.inputSchema).toHaveProperty("properties.fastMode");
        expect(spec?.description).not.toContain("collect=true");
      }
    }
    if (registeredTools) {
      expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["sessions_spawn"]);
      expect(
        flattenCodexDynamicToolFunctions(bridge.availableSpecs).map((tool) => tool.name),
      ).toEqual(["sessions_spawn"]);
    }
    if (kind === "quarantined") {
      expect(bridge.telemetry.quarantinedTools).toEqual(
        expect.arrayContaining([expect.objectContaining({ tool: "agents_wait" })]),
      );
    }
    const result = await bridge.handleToolCall({
      callId: "uncollectable",
      threadId: "thread",
      turnId: "turn",
      tool: "sessions_spawn",
      arguments: { task: "inspect", collect: true },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.contentItems)).toMatch(
      /Collector results are unavailable|Invalid arguments/,
    );
  });
});
