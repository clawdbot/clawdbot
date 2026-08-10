import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createModelExecSchema, execSchema, nodeExecSchema } from "./bash-tools.schemas.js";
import { isCodeModeExecControlTool } from "./code-mode-control-tools.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
  ToolSearchRuntime,
} from "./tool-search.js";

function hostTargets(schema: { properties: { host?: unknown } }): string[] | undefined {
  return (schema.properties.host as { enum?: string[] } | undefined)?.enum;
}

function hostDescription(schema: { properties: { host?: unknown } }): string | undefined {
  return (schema.properties.host as { description?: string } | undefined)?.description;
}

describe("lazy exec model schema", () => {
  it.each([
    {
      name: "auto with sandbox",
      defaults: { host: "auto" as const, sandbox: {} as never },
      expected: ["auto", "sandbox"],
    },
    {
      name: "auto without sandbox",
      defaults: { host: "auto" as const },
      expected: ["auto", "gateway", "node"],
    },
    {
      name: "gateway pinned",
      defaults: { host: "gateway" as const },
      expected: ["gateway"],
    },
    {
      name: "sandbox pinned",
      defaults: { host: "sandbox" as const, sandbox: {} as never },
      expected: ["sandbox"],
    },
    {
      name: "node pinned",
      defaults: { host: "node" as const },
      expected: ["node"],
    },
  ])("advertises only policy-authorized targets for $name", ({ defaults, expected }) => {
    const schema = createModelExecSchema(defaults);

    expect(schema).toBeDefined();
    expect(hostTargets(schema!)).toEqual(expected);
    expect(schema!.properties.elevated).toBeUndefined();
    expect(hostDescription(schema!)).toBe(
      `Policy-authorized exec target (${expected.join("|")}); endpoint reachability is checked at runtime.`,
    );
  });

  it("advertises optional elevation only when prepared policy allows it", () => {
    const schema = createModelExecSchema({
      host: "gateway",
      elevated: { enabled: true, allowed: true, defaultLevel: "off" },
    });

    expect(schema).toBeDefined();
    expect(schema!.properties.elevated).toBeDefined();
    expect(schema!.required).not.toContain("elevated");
    expect(Value.Check(schema!, { command: "id", elevated: false })).toBe(true);
    expect(Value.Check(schema!, { command: "id", elevated: true })).toBe(true);
  });

  it("requires explicit elevation for pinned sandbox without a sandbox", () => {
    const schema = createModelExecSchema({
      host: "sandbox",
      elevated: { enabled: true, allowed: true, defaultLevel: "off" },
    });

    expect(schema).toBeDefined();
    expect(hostTargets(schema!)).toEqual(["sandbox"]);
    expect(schema!.required).toContain("elevated");
    expect(Value.Check(schema!, { command: "id", elevated: true })).toBe(true);
    expect(Value.Check(schema!, { command: "id" })).toBe(false);
    expect(Value.Check(schema!, { command: "id", elevated: false })).toBe(false);
  });

  it.each(["on", "ask", "full"] as const)(
    "allows elevated default %s for pinned sandbox without a sandbox",
    (defaultLevel) => {
      const schema = createModelExecSchema({
        host: "sandbox",
        elevated: { enabled: true, allowed: true, defaultLevel },
      });

      expect(schema).toBeDefined();
      expect(schema!.required).not.toContain("elevated");
      expect(Value.Check(schema!, { command: "id" })).toBe(true);
      expect(Value.Check(schema!, { command: "id", elevated: true })).toBe(true);
      expect(Value.Check(schema!, { command: "id", elevated: false })).toBe(false);
    },
  );

  it.each([
    { elevated: { enabled: false, allowed: true, defaultLevel: "off" as const } },
    { elevated: { enabled: true, allowed: false, defaultLevel: "off" as const } },
  ])("omits pinned unavailable sandbox exec when elevation is unavailable", ({ elevated }) => {
    expect(createModelExecSchema({ host: "sandbox", elevated })).toBeUndefined();
  });

  it.each([{ mode: "deny" as const }, { security: "deny" as const }])(
    "omits exec for deterministic static policy deny",
    (policy) => {
      expect(createModelExecSchema({ host: "gateway", ...policy })).toBeUndefined();
    },
  );

  it("keeps mode precedence when legacy security is also present", () => {
    expect(
      createModelExecSchema({
        host: "gateway",
        mode: "full",
        security: "deny",
        ask: "always",
      }),
    ).toBeDefined();
  });

  it("preserves the full internal parser schema and node-only presentation", () => {
    createModelExecSchema({ host: "auto" });

    expect(hostTargets(execSchema)).toEqual(["auto", "sandbox", "gateway", "node"]);
    expect(hostTargets(nodeExecSchema)).toEqual(["node"]);
  });

  it("keeps explicit presentation parameters authoritative", () => {
    const parameters = Type.Object({ command: Type.String() });

    expect(createLazyExecTool({ host: "sandbox" }, { parameters }).parameters).toBe(parameters);
  });

  it("projects one raw exec schema through direct, Tool Search, and Code Mode", async () => {
    const parameters = createModelExecSchema({ host: "auto" });
    const tool = createLazyExecTool({ host: "auto" }, { parameters: parameters! });
    const toolSearchCatalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef: toolSearchCatalogRef, tools: [tool] });
    const toolSearchRuntime = new ToolSearchRuntime(
      { catalogRef: toolSearchCatalogRef },
      resolveToolSearchConfig({ tools: { toolSearch: true } } as never),
    );
    const described = await toolSearchRuntime.describe("exec");

    const codeModeCatalogRef = createToolSearchCatalogRef();
    const config = { tools: { codeMode: true } } as never;
    const codeModeTools = createCodeModeTools({
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef: codeModeCatalogRef,
    });
    const compacted = applyCodeModeCatalog({
      tools: [...codeModeTools, tool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef: codeModeCatalogRef,
    });
    const outerExec = compacted.tools.find(isCodeModeExecControlTool);
    const nestedExec = codeModeCatalogRef.current?.entries.find(
      (entry) => entry.id === "openclaw:core:exec",
    );

    expect(described.parameters).toBe(tool.parameters);
    expect(nestedExec?.parameters).toBe(tool.parameters);
    expect(hostTargets(tool.parameters as never)).toEqual(["auto", "gateway", "node"]);
    expect(isCodeModeExecControlTool(nestedExec?.tool as never)).toBe(false);
    expect(outerExec?.parameters).toHaveProperty("properties.code");
    expect(outerExec?.parameters).toHaveProperty("properties.language");
    expect(outerExec?.parameters).not.toHaveProperty("properties.host");
  });
});
