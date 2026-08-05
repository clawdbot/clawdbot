import { expectDefined } from "@openclaw/normalization-core";
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
    // 127 ASCII code units + one supplementary character (2 UTF-16 code units) = 129 units.
    // A naive .slice(0, 128) keeps the high surrogate and drops the low surrogate,
    // producing a lone surrogate in the model-facing system prompt.
    const emoji = "\uD83D\uDCF1"; // 📱 U+1F4F1
    const displayName = "a".repeat(127) + emoji;
    const catalog = [
      mcpCatalogEntry({
        id: "github__read_file",
        node: { id: "node-1", displayName },
      }),
    ];
    const prompt = describeCodeModeNamespacesForPrompt(catalog);
    // The prompt should mention the node label without a dangling high surrogate.
    const labelMatch = prompt.match(/\(node: (.+)\)/);
    expect(labelMatch).not.toBeNull();
    const label = expectDefined(labelMatch?.[1], "node label capture group");
    // No lone high surrogate at the end: the emoji must be fully present or fully absent.
    expect(label.endsWith("\uD83D")).toBe(false);
    expect(label.length).toBe(127);
  });
});
