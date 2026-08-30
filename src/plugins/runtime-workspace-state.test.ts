// Verifies that runtime workspace reads follow the active registry.
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

function setActiveWorkspace(workspaceDir: string): void {
  setActivePluginRegistry(
    createEmptyPluginRegistry(),
    workspaceDir,
    "gateway-bindable",
    workspaceDir,
  );
}

describe("runtime workspace state", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("reads the live global workspace dir", () => {
    setActiveWorkspace("/workspace/a");
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/a");

    setActiveWorkspace("/workspace/b");
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/b");
  });
});
