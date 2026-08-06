// Verifies request-scoped plugin workspace pins under concurrent registry mutation.
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
import { withPinnedActivePluginRegistryWorkspaceDir } from "./runtime-workspace-state.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

function setActiveWorkspace(workspaceDir: string): void {
  setActivePluginRegistry(
    createEmptyPluginRegistry(),
    workspaceDir,
    "gateway-bindable",
    workspaceDir,
  );
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver");
  }
  return { promise, resolve };
}

describe("runtime workspace state pin", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("reads the live global workspace dir when no pin is active", () => {
    setActiveWorkspace("/workspace/a");
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/a");

    setActiveWorkspace("/workspace/b");
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/b");
  });

  it("isolates overlapping pins and restores live state after success", async () => {
    const firstPinned = createDeferred();
    const resumeFirst = createDeferred();
    const firstObserved: Array<string | undefined> = [];

    setActiveWorkspace("/workspace/a");
    const firstRequest = withPinnedActivePluginRegistryWorkspaceDir(async () => {
      firstObserved.push(getActivePluginRegistryWorkspaceDirFromState());
      firstPinned.resolve();
      await resumeFirst.promise;
      firstObserved.push(getActivePluginRegistryWorkspaceDirFromState());
    });
    await firstPinned.promise;

    setActiveWorkspace("/workspace/b");
    const secondObserved = await withPinnedActivePluginRegistryWorkspaceDir(async () => {
      const observed = [getActivePluginRegistryWorkspaceDirFromState()];
      setActiveWorkspace("/workspace/c");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      observed.push(getActivePluginRegistryWorkspaceDirFromState());
      return observed;
    });

    resumeFirst.resolve();
    await firstRequest;

    expect(firstObserved).toEqual(["/workspace/a", "/workspace/a"]);
    expect(secondObserved).toEqual(["/workspace/b", "/workspace/b"]);
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/c");
  });

  it("reuses the outer pin for nested scopes", async () => {
    setActiveWorkspace("/workspace/a");

    await withPinnedActivePluginRegistryWorkspaceDir(async () => {
      setActiveWorkspace("/workspace/b");
      await withPinnedActivePluginRegistryWorkspaceDir(async () => {
        expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/a");
      });
    });

    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/b");
  });

  it("preserves the pin across module reloads", async () => {
    setActiveWorkspace("/workspace/a");

    await withPinnedActivePluginRegistryWorkspaceDir(async () => {
      setActiveWorkspace("/workspace/b");
      const reloaded = await import(
        new URL("./runtime-workspace-state.ts?workspace-pin-reload", import.meta.url).href
      );

      expect(reloaded.getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/a");
    });
  });

  it("propagates rejections without leaking the pin", async () => {
    setActiveWorkspace("/workspace/a");

    await expect(
      withPinnedActivePluginRegistryWorkspaceDir(async () => {
        setActiveWorkspace("/workspace/b");
        throw new Error("workspace request failed");
      }),
    ).rejects.toThrow("workspace request failed");

    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/b");
  });
});
