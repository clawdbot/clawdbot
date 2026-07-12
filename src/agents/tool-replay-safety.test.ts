import { describe, expect, it } from "vitest";
import {
  collectReplaySafeToolNames,
  isAgentToolReplaySafe,
  isAgentToolRestartSafe,
  isCoreToolNameReplaySafe,
} from "./tool-replay-safety.js";

describe("agent tool replay safety", () => {
  it("allows only audited unconditional core tools", () => {
    expect(isAgentToolReplaySafe({ name: "search" })).toBe(true);
    expect(isAgentToolReplaySafe({ name: "update_plan" })).toBe(true);
    expect(isAgentToolReplaySafe({ name: "process" })).toBe(false);
    expect(isAgentToolReplaySafe({ name: "vendor_widget" })).toBe(false);
  });

  it("requires extension-owned tools to opt in even when they reuse an audited name", () => {
    const pluginTool = { name: "search" };

    expect(
      isAgentToolReplaySafe(pluginTool, {
        declaredReplaySafe: (tool) => (tool === pluginTool ? false : undefined),
      }),
    ).toBe(false);
  });

  it("accepts opted-in extension tools only for audited names", () => {
    const xSearch = { name: "x_search" };
    const vendorWidget = { name: "vendor_widget" };
    const declaredReplaySafe = () => true;

    expect(isAgentToolReplaySafe(xSearch, { declaredReplaySafe })).toBe(true);
    expect(isAgentToolReplaySafe(vendorWidget, { declaredReplaySafe })).toBe(false);
  });

  it("accepts owner-declared concrete tools for restart-safe turns", () => {
    const pluginTool = { name: "vendor_widget" };

    expect(
      isAgentToolRestartSafe(pluginTool, {
        declaredReplaySafe: (tool) => (tool === pluginTool ? true : undefined),
      }),
    ).toBe(true);
    expect(
      isAgentToolRestartSafe(pluginTool, {
        declaredReplaySafe: () => false,
      }),
    ).toBe(false);
  });

  it("rejects memory_search because it records durable recall signals", () => {
    expect(
      isAgentToolReplaySafe(
        { name: "memory_search" },
        {
          declaredReplaySafe: () => true,
        },
      ),
    ).toBe(false);
  });

  it("rejects duplicate names from name-only replay metadata", () => {
    const coreTool = { name: "search" };
    const pluginTool = { name: "search" };

    expect(
      collectReplaySafeToolNames([coreTool, pluginTool], {
        declaredReplaySafe: (tool) => (tool === pluginTool ? true : undefined),
      }),
    ).toEqual(new Set());
  });

  it("classifies fixture names with the same audited contract", () => {
    expect(isCoreToolNameReplaySafe("web_search")).toBe(true);
    expect(isCoreToolNameReplaySafe("browser")).toBe(false);
  });
});
