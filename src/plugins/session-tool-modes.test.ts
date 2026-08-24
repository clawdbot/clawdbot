import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { resolveSessionToolMode } from "./session-tool-modes.js";

afterEach(() => resetPluginRuntimeStateForTest());

function installModes() {
  const registry = createEmptyPluginRegistry();
  registry.sessionToolModes = [
    {
      pluginId: "developer-mode",
      mode: {
        id: "standard",
        label: "Standard",
        controlLabel: "Tool mode",
        default: true,
        toolProfile: "coding",
        codeMode: "direct",
      },
      source: "test",
    },
  ];
  setActivePluginRegistry(registry);
}

describe("session Tool mode resolution", () => {
  it("uses the registered default only for a compatible runtime", () => {
    installModes();
    expect(resolveSessionToolMode({ runtimeId: "openclaw" })).toMatchObject({
      status: "available",
      selection: { pluginId: "developer-mode", modeId: "standard" },
    });
    expect(resolveSessionToolMode({ runtimeId: "codex" })).toBeUndefined();
  });

  it("distinguishes incompatible and unavailable persisted selections", () => {
    installModes();
    const selection = { pluginId: "developer-mode", modeId: "standard" };
    expect(resolveSessionToolMode({ selection, runtimeId: "codex" })?.status).toBe("incompatible");
    resetPluginRuntimeStateForTest();
    expect(resolveSessionToolMode({ selection, runtimeId: "openclaw" })?.status).toBe(
      "unavailable",
    );
  });
});
