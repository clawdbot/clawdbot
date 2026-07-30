import { describe, expect, it } from "vitest";
import {
  buildCliBackendToolAvailability,
  resolveCliRuntimeToolsAllow,
  resolveCliSessionToolsAllow,
  stripOpenClawMcpToolPrefix,
} from "./tool-policy.js";

describe("buildCliBackendToolAvailability", () => {
  it("keeps canonical names and projects the shipped beta MCP transport names", () => {
    expect(
      buildCliBackendToolAvailability({ native: ["Read"], openClaw: ["message", "write"] }),
    ).toEqual({
      native: ["Read"],
      openClaw: ["message", "write"],
      mcp: ["mcp__openclaw__message", "mcp__openclaw__write"],
    });
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
  it("keeps every concrete restriction, including server-managed defaults", () => {
    expect(resolveCliRuntimeToolsAllow(undefined)).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["memory_search"], true)).toEqual(["memory_search"]);
    expect(resolveCliRuntimeToolsAllow(["*"])).toBeUndefined();
    expect(resolveCliRuntimeToolsAllow(["memory_search"])).toEqual(["memory_search"]);
  });
});

describe("resolveCliSessionToolsAllow", () => {
  it("preserves the existing runtime cap when the session has no per-spawn policy", () => {
    expect(
      resolveCliSessionToolsAllow({
        toolsAllow: ["message"],
        toolsAllowIsDefault: true,
        sessionPolicy: undefined,
      }),
    ).toEqual(["message"]);
  });

  it("uses an allow-only per-spawn policy when no other runtime cap is active", () => {
    expect(
      resolveCliSessionToolsAllow({
        sessionPolicy: { allow: ["read"] },
      }),
    ).toEqual(["read"]);
  });

  it("keeps deny-all when either independent runtime cap is empty", () => {
    expect(
      resolveCliSessionToolsAllow({
        toolsAllow: [],
        sessionPolicy: { allow: ["read"] },
      }),
    ).toEqual([]);
  });

  it("fails closed instead of replacing an independent runtime cap", () => {
    expect(() =>
      resolveCliSessionToolsAllow({
        toolsAllow: ["message"],
        sessionPolicy: { allow: ["read"] },
      }),
    ).toThrow("cannot combine");
  });
});
