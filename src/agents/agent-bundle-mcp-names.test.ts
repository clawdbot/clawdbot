/** Tests MCP server/tool name sanitization, truncation, and collision handling. */
import { describe, expect, it } from "vitest";
import {
  buildSafeToolName,
  couldMaterializeToolName,
  normalizeReservedToolNames,
  safeToolNameGlob,
  sanitizeNodeIdFragment,
  sanitizeServerName,
  TOOL_NAME_SEPARATOR,
} from "./agent-bundle-mcp-names.js";

describe("agent bundle MCP names", () => {
  it.each([
    { value: "", expected: "node" },
    { value: " North !! Node ", expected: "north_node" },
    { value: "123-node", expected: "node_123_node" },
    { value: "a".repeat(40), expected: "a".repeat(32) },
  ])("sanitizes node ID fragment $value", ({ value, expected }) => {
    expect(sanitizeNodeIdFragment(value)).toBe(expected);
  });

  it("sanitizes and disambiguates server names", () => {
    const usedNames = new Set<string>();

    expect(sanitizeServerName("vigil-harbor", usedNames)).toBe("vigil-harbor");
    expect(sanitizeServerName("vigil:harbor", usedNames)).toBe("vigil-harbor-2");
  });

  it("keeps server and tool fragments provider-safe when they start with digits", () => {
    const usedNames = new Set<string>();
    const serverName = sanitizeServerName("12306", usedNames);

    expect(serverName).toBe("mcp-12306");
    expect(
      buildSafeToolName({
        serverName,
        toolName: "2024-query",
        reservedNames: new Set(),
      }),
    ).toBe(`mcp-12306${TOOL_NAME_SEPARATOR}tool-2024-query`);
  });

  it("builds provider-safe tool names and avoids collisions", () => {
    const reservedNames = normalizeReservedToolNames(["memory__status"]);

    const safeToolName = buildSafeToolName({
      serverName: "memory",
      toolName: "status",
      reservedNames,
    });
    expect(safeToolName).toBe(`memory${TOOL_NAME_SEPARATOR}status-2`);
  });

  it("uses the bundle server name for Link MCP tools", () => {
    const usedServerNames = new Set<string>();
    const serverName = sanitizeServerName("link", usedServerNames);

    expect(
      buildSafeToolName({
        serverName,
        toolName: "auth_login",
        reservedNames: new Set(),
      }),
    ).toBe(`link${TOOL_NAME_SEPARATOR}auth_login`);
    expect(
      buildSafeToolName({
        serverName,
        toolName: "spend-request_create",
        reservedNames: new Set(),
      }),
    ).toBe(`link${TOOL_NAME_SEPARATOR}spend-request_create`);
  });

  it("truncates overlong tool names while keeping the server prefix", () => {
    const safeToolName = buildSafeToolName({
      serverName: "memory",
      toolName: "x".repeat(200),
      reservedNames: new Set(),
    });

    expect(safeToolName.startsWith(`memory${TOOL_NAME_SEPARATOR}`)).toBe(true);
    expect(safeToolName.length).toBeLessThanOrEqual(64);
  });

  it("recognizes the normalized names buildSafeToolName can emit", () => {
    const reservedNames = new Set<string>();
    for (const toolName of ["read_note", "1note", "-note", "n".repeat(80)]) {
      const emitted = buildSafeToolName({ serverName: "memos", toolName, reservedNames });
      expect(couldMaterializeToolName(emitted.toLowerCase(), "memos__")).toBe(true);
    }
    for (const name of ["memos__1note", "memos__-note", `memos__${"n".repeat(60)}`, "memos__"]) {
      expect(couldMaterializeToolName(name, "memos__")).toBe(false);
    }
  });

  it.each([
    { pattern: "read_*", expected: "memos__read_*" },
    { pattern: " Read Note ", expected: "memos__read-note" },
    { pattern: "a**b", expected: "memos__a**b" },
    { pattern: "*", expected: "memos__*" },
    { pattern: "", expected: "memos__" },
  ])(
    "maps the tool-filter pattern $pattern onto normalized safe names",
    ({ pattern, expected }) => {
      expect(safeToolNameGlob("Memos", pattern)).toBe(expected);
    },
  );

  it("maps a literal filter pattern onto the name buildSafeToolName gives that tool", () => {
    const reservedNames = new Set<string>();
    const emitted = buildSafeToolName({
      serverName: "memos",
      toolName: "Read Note",
      reservedNames,
    });
    expect(safeToolNameGlob("memos", "Read Note")).toBe(emitted.toLowerCase());
  });

  it("maps a non-letter-led filter literal to a name buildSafeToolName never emits", () => {
    // Accepted hide-side difference: the real name gains a `tool-` prefix.
    const reservedNames = new Set<string>();
    const emitted = buildSafeToolName({ serverName: "memos", toolName: "1note", reservedNames });
    expect(emitted).toBe("memos__tool-1note");
    expect(couldMaterializeToolName(safeToolNameGlob("memos", "1note"), "memos__")).toBe(false);
  });
});
