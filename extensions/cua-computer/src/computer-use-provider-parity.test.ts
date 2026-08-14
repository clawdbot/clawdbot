import { describe, expect, it } from "vitest";
import {
  COMPUTER_USE_V2_PROVIDER_ACTION_SUPPORT,
  type DeliveryModeSupport,
  PEEKABOO_MCP_TOOL_NAMES,
  PEEKABOO_MCP_TOOL_PARITY,
  PEEKABOO_PROVIDER_PARITY_SOURCE,
} from "./computer-use-peekaboo-parity.test-fixtures.js";
import {
  COMPUTER_USE_V2_ACTION_NAMES,
  CUA_MCP_TOOL_NAMES,
  CUA_MCP_TOOL_PARITY,
  CUA_PROVIDER_PARITY_SOURCE,
} from "./computer-use-provider-parity.test-fixtures.js";

describe("computer-use provider parity fixtures", () => {
  it("freezes the real pinned provider inventories", () => {
    expect(CUA_MCP_TOOL_NAMES).toHaveLength(CUA_PROVIDER_PARITY_SOURCE.registryToolCounts.union);
    expect(PEEKABOO_MCP_TOOL_NAMES).toHaveLength(PEEKABOO_PROVIDER_PARITY_SOURCE.catalogToolCount);

    const cuaPlatformCounts = {
      macos: CUA_MCP_TOOL_PARITY.filter(({ platforms }) => platforms.includes("macos")).length,
      windows: CUA_MCP_TOOL_PARITY.filter(({ platforms }) => platforms.includes("windows")).length,
      linux: CUA_MCP_TOOL_PARITY.filter(({ platforms }) => platforms.includes("linux")).length,
    };
    expect(cuaPlatformCounts).toEqual({ macos: 53, windows: 54, linux: 57 });
  });

  it.each([
    ["CUA", CUA_MCP_TOOL_NAMES, CUA_MCP_TOOL_PARITY],
    ["Peekaboo", PEEKABOO_MCP_TOOL_NAMES, PEEKABOO_MCP_TOOL_PARITY],
  ] as const)("classifies every %s MCP tool exactly once", (_provider, toolNames, parity) => {
    const classifiedNames = parity.map(({ tool }) => tool);
    expect(new Set(toolNames).size).toBe(toolNames.length);
    expect(new Set(classifiedNames).size).toBe(classifiedNames.length);
    expect(new Set(classifiedNames)).toEqual(new Set(toolNames));
  });

  it.each([
    ["CUA", CUA_MCP_TOOL_PARITY],
    ["Peekaboo", PEEKABOO_MCP_TOOL_PARITY],
  ] as const)("keeps every %s portable mapping inside the v2 action union", (_provider, parity) => {
    const validActions = new Set(COMPUTER_USE_V2_ACTION_NAMES);
    for (const entry of parity) {
      if (entry.classification !== "portable-action") {
        continue;
      }
      expect(entry.actions.length).toBeGreaterThan(0);
      expect(entry.actions.every((action) => validActions.has(action))).toBe(true);
      expect(new Set(entry.actions).size).toBe(entry.actions.length);
    }
  });

  it("maps every v2 action to provider tools or an explained unmapped marker", () => {
    const supportedActions = COMPUTER_USE_V2_PROVIDER_ACTION_SUPPORT.map(({ action }) => action);
    expect(new Set(supportedActions).size).toBe(supportedActions.length);
    expect(new Set(supportedActions)).toEqual(new Set(COMPUTER_USE_V2_ACTION_NAMES));

    const cuaToolNames = new Set(CUA_MCP_TOOL_NAMES);
    const peekabooToolNames = new Set(PEEKABOO_MCP_TOOL_NAMES);
    for (const entry of COMPUTER_USE_V2_PROVIDER_ACTION_SUPPORT) {
      expect(new Set(entry.cuaTools).size).toBe(entry.cuaTools.length);
      expect(new Set(entry.peekabooTools).size).toBe(entry.peekabooTools.length);
      expect(entry.cuaTools.every((tool) => cuaToolNames.has(tool))).toBe(true);
      expect(entry.peekabooTools.every((tool) => peekabooToolNames.has(tool))).toBe(true);

      if (entry.support === "unmapped") {
        expect(entry.unmappedReason.trim()).not.toBe("");
        expect(entry.cuaTools).toHaveLength(0);
        expect(entry.peekabooTools).toHaveLength(0);
        continue;
      }

      expect(entry.cuaTools.length + entry.peekabooTools.length).toBeGreaterThan(0);
      expect(entry.support).toBe(
        entry.cuaTools.length > 0 && entry.peekabooTools.length > 0
          ? "both"
          : entry.cuaTools.length > 0
            ? "cua"
            : "peekaboo",
      );

      for (const [provider, delivery] of Object.entries<DeliveryModeSupport>(
        entry.deliveryModes ?? {},
      )) {
        expect(delivery.modes.length).toBeGreaterThan(0);
        expect(new Set(delivery.modes).size).toBe(delivery.modes.length);
        expect(delivery.modes.every((mode) => mode === "background" || mode === "foreground")).toBe(
          true,
        );
        expect(delivery.note.trim()).not.toBe("");
        expect(
          provider === "cua" ? entry.cuaTools.length : entry.peekabooTools.length,
        ).toBeGreaterThan(0);
      }
    }
  });
});
