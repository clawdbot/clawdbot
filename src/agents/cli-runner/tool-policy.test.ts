import { describe, expect, it } from "vitest";
import {
  resolveCliRuntimeToolsAllow,
  resolveLoopbackToolsAllowFromMcpPermissions,
  stripOpenClawMcpToolPrefix,
} from "./tool-policy.js";

describe("resolveLoopbackToolsAllowFromMcpPermissions", () => {
  it("returns undefined when no MCP permission list is set", () => {
    expect(resolveLoopbackToolsAllowFromMcpPermissions(undefined)).toBeUndefined();
  });

  it("maps prefixed loopback names to gateway tool names", () => {
    expect(
      resolveLoopbackToolsAllowFromMcpPermissions([
        "mcp__openclaw__memory_search",
        "mcp__openclaw__memory_get",
      ]),
    ).toEqual(["memory_search", "memory_get"]);
  });

  it("keeps the full surface on wildcard entries", () => {
    expect(resolveLoopbackToolsAllowFromMcpPermissions(["mcp__openclaw__*"])).toBeUndefined();
    expect(
      resolveLoopbackToolsAllowFromMcpPermissions(["mcp__openclaw__memory_search", "*"]),
    ).toBeUndefined();
  });

  it("drops tools owned by other MCP servers and fails closed when none remain", () => {
    expect(
      resolveLoopbackToolsAllowFromMcpPermissions([
        "mcp__other__thing",
        "mcp__openclaw__memory_search",
      ]),
    ).toEqual(["memory_search"]);
    // Only foreign-server entries: the loopback surface exposes nothing.
    expect(resolveLoopbackToolsAllowFromMcpPermissions(["mcp__other__thing"])).toEqual([]);
  });

  it("normalizes and dedupes unprefixed entries", () => {
    expect(
      resolveLoopbackToolsAllowFromMcpPermissions([" Memory_Search ", "memory_search"]),
    ).toEqual(["memory_search"]);
  });
});

describe("stripOpenClawMcpToolPrefix", () => {
  it("strips only the loopback transport prefix", () => {
    expect(stripOpenClawMcpToolPrefix("mcp__openclaw__memory_search")).toBe("memory_search");
    expect(stripOpenClawMcpToolPrefix("memory_search")).toBe("memory_search");
    expect(stripOpenClawMcpToolPrefix("mcp__other__tool")).toBe("mcp__other__tool");
  });
});

describe("resolveCliRuntimeToolsAllow", () => {
  it("keeps only real restrictions", () => {
    expect(resolveCliRuntimeToolsAllow(undefined)).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["memory_search"], true)).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["*"])).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["memory_search"])).toEqual(["memory_search"]);
  });
});
