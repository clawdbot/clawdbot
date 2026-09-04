import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { describe, expect, it } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

function createCollectorTools() {
  return createOpenClawCodingTools({
    sessionKey: "agent:main:main",
    runId: "parent",
    config: {
      agents: { entries: { main: { default: true } } },
      tools: { profile: "coding" },
    },
  }).filter((tool) => tool.name === "sessions_spawn" || tool.name === "agents_wait");
}

describe("Codex collector availability", () => {
  it.each(["direct", "searchable"] as const)(
    "keeps collection for registered readers with %s loading and native-spec precedence",
    (loading) => {
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
      expect(inherited.specs).toEqual(initial.specs);
      for (const bridge of [initial, inherited]) {
        const spawn = bridge.availableTools.find((tool) => tool.name === "sessions_spawn");
        expect(spawn?.parameters).toHaveProperty("properties.collect");
        expect(spawn?.description).toContain("await with agents_wait");
        expect(flattenCodexDynamicToolFunctions(bridge.specs).map((tool) => tool.name)).toEqual(
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
