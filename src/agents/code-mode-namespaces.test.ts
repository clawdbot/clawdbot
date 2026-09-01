import { describe, expect, it, vi } from "vitest";
import {
  createCodeModeNamespaceRuntime,
  describeCodeModeNamespacesForPrompt,
} from "./code-mode-namespaces.js";

type McpCatalogEntry = NonNullable<Parameters<typeof createCodeModeNamespaceRuntime>[0]>[number];

function mcpCatalogEntry(params: {
  id: string;
  serverName?: string;
  safeServerName?: string;
  toolName?: string;
  description?: string;
  parameters?: unknown;
  operation?: NonNullable<McpCatalogEntry["mcp"]>["operation"];
  node?: NonNullable<McpCatalogEntry["mcp"]>["node"];
}): McpCatalogEntry {
  const serverName = params.serverName ?? "github";
  const toolName = params.toolName ?? "read_file";
  return {
    id: params.id,
    name: params.id,
    source: "mcp",
    description: params.description,
    parameters: params.parameters ?? { type: "object", properties: {} },
    mcp: {
      serverName,
      safeServerName: params.safeServerName ?? serverName,
      toolName,
      operation: params.operation ?? "tool",
      ...(params.node ? { node: params.node } : {}),
    },
  };
}

describe("Code Mode MCP namespace model", () => {
  it("keeps run-owned namespace descriptors and virtual API files in sync", async () => {
    const catalog = [
      mcpCatalogEntry({
        id: "github__read_file",
        description: "Read repository 名称.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Repository 名称" } },
          required: ["path"],
        },
      }),
    ];
    const runtime = createCodeModeNamespaceRuntime(catalog);

    expect(runtime.descriptors.map((descriptor) => descriptor.globalName)).toEqual(["MCP"]);
    expect(runtime.apiFiles.map((file) => file.path)).toEqual([
      "agents.d.ts",
      "mcp/index.d.ts",
      "mcp/github.d.ts",
    ]);
    for (const file of runtime.apiFiles) {
      expect(file.bytes).toBe(Buffer.byteLength(file.content, "utf8"));
    }

    catalog[0] = mcpCatalogEntry({ id: "replacement__tool", serverName: "replacement" });
    const executeTool = vi.fn(async ({ input }: { input: unknown }) => input);
    await expect(
      runtime.invoke("mcp", ["github", "readFile"], [{ path: "README.md" }], executeTool),
    ).resolves.toEqual({ path: "README.md" });
    expect(runtime.apiFiles.map((file) => file.path)).toEqual([
      "agents.d.ts",
      "mcp/index.d.ts",
      "mcp/github.d.ts",
    ]);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ catalogId: "github__read_file", toolName: "github__read_file" }),
    );
  });

  it.each([
    {
      name: "enum",
      items: { type: "string", enum: ["red", "blue"] },
      declaration: 'Array<"red" | "blue">',
    },
    {
      name: "anyOf",
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
      declaration: "Array<string | number>",
    },
    {
      name: "oneOf",
      items: { oneOf: [{ type: "boolean" }, { type: "null" }] },
      declaration: "Array<boolean | null>",
    },
    {
      name: "multiple types",
      items: { type: ["string", "null"] },
      declaration: "Array<string | null>",
    },
    {
      name: "nested array",
      items: { type: "array", items: { type: "string", enum: ["red", "blue"] } },
      declaration: 'Array<Array<"red" | "blue">>',
    },
    {
      name: "simple array",
      items: { type: "string" },
      declaration: "Array<string>",
    },
    {
      name: "object",
      items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      declaration: "Array<{ id: string }>",
    },
  ])("preserves $name item grouping in MCP API declarations", async ({ items, declaration }) => {
    const parameters = {
      type: "object",
      properties: { values: { type: "array", items } },
      required: ["values"],
    };
    const runtime = createCodeModeNamespaceRuntime([
      mcpCatalogEntry({ id: "github__read_file", parameters }),
    ]);
    const executeTool = vi.fn();
    const api = await runtime.invoke(
      "mcp",
      ["github", "$api"],
      ["readFile", { schema: true }],
      executeTool,
    );

    expect(runtime.apiFiles.find((file) => file.path === "mcp/github.d.ts")?.content).toContain(
      `values: ${declaration};`,
    );
    expect(api).toMatchObject({
      header: expect.stringContaining(`values: ${declaration};`),
      schemas: { readFile: parameters },
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it.each(["constructor", "toString", "__proto__"])(
    "does not satisfy required MCP argument %s from Object.prototype",
    async (key) => {
      const runtime = createCodeModeNamespaceRuntime([
        mcpCatalogEntry({
          id: "github__read_file",
          parameters: {
            type: "object",
            properties: { [key]: { type: "string" } },
            required: [key],
          },
        }),
      ]);
      const executeTool = vi.fn(async ({ input }: { input: unknown }) => input);

      await expect(
        runtime.invoke("mcp", ["github", "readFile"], [{}], executeTool),
      ).rejects.toThrow(`Missing required MCP namespace argument: ${key}`);
      expect(executeTool).not.toHaveBeenCalled();

      await expect(
        runtime.invoke("mcp", ["github", "readFile"], [{ [key]: "provided" }], executeTool),
      ).resolves.toEqual({ [key]: "provided" });
    },
  );

  it.each(["constructor", "toString", "__proto__"])(
    "applies MCP argument default %s as a safe own property",
    async (key) => {
      const runtime = createCodeModeNamespaceRuntime([
        mcpCatalogEntry({
          id: "github__read_file",
          parameters: {
            type: "object",
            properties: { [key]: { type: "string", default: "safe" } },
            required: [key],
          },
        }),
      ]);
      const executeTool = vi.fn(async ({ input }: { input: unknown }) => input);

      await expect(
        runtime.invoke("mcp", ["github", "readFile"], [{}], executeTool),
      ).resolves.toEqual({ [key]: "safe" });
      const input = executeTool.mock.calls[0]?.[0]?.input as Record<string, unknown>;
      expect(Object.hasOwn(input, key)).toBe(true);
      expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    },
  );

  it("keeps forbidden and JavaScript-keyword namespace identifiers callable and escaped", async () => {
    const catalog = [
      mcpCatalogEntry({
        id: "constructor__prototype",
        serverName: "constructor",
        toolName: "prototype",
      }),
      mcpCatalogEntry({ id: "github__delete", toolName: "delete" }),
      mcpCatalogEntry({ id: "github__enum", toolName: "enum" }),
    ];
    const runtime = createCodeModeNamespaceRuntime(catalog);
    const executeTool = vi.fn(async ({ toolName }: { toolName: string }) => toolName);

    await expect(
      runtime.invoke("mcp", ["constructor2", "prototype2"], [{}], executeTool),
    ).resolves.toBe("constructor__prototype");
    await expect(runtime.invoke("mcp", ["github", "delete2"], [{}], executeTool)).resolves.toBe(
      "github__delete",
    );
    await expect(runtime.invoke("mcp", ["github", "enum2"], [{}], executeTool)).resolves.toBe(
      "github__enum",
    );
  });

  it("rejects prototype and NUL-delimited paths before calling tools", async () => {
    const runtime = createCodeModeNamespaceRuntime([mcpCatalogEntry({ id: "github__read_file" })]);
    const executeTool = vi.fn(async () => "unexpected");

    for (const path of [
      ["__proto__", "readFile"],
      ["constructor", "readFile"],
      ["github", "prototype"],
      ["github", "read\u0000File"],
    ]) {
      await expect(runtime.invoke("mcp", path, [{}], executeTool)).rejects.toThrow(
        "Invalid code mode namespace path segment",
      );
    }
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("does not split UTF-16 surrogate pairs in node display names at the 128-char boundary", () => {
    const displayName = `${"a".repeat(127)}\uD83D\uDCF1`;
    const catalog = [
      mcpCatalogEntry({
        id: "github__read_file",
        node: { id: "node-1", displayName },
      }),
    ];
    const prompt = describeCodeModeNamespacesForPrompt(catalog);

    expect(prompt).toContain(`visible servers: github (node: ${"a".repeat(127)}).`);
    expect(prompt).not.toContain("\uD83D");
  });
});
