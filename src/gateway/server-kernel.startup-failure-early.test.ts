// #120332 round 56 (P2): pre-lifecycle failure cleanup is scoped to state THIS kernel attempt
// published. An embedded process can already run a Gateway whose registry and config snapshot
// the process globals hold — a second attempt failing during preflight (before publishing its
// own) must leave the running instance's state intact.
import { describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createGatewayKernel } from "./server-kernel.js";

vi.mock("./server-startup-bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-startup-bootstrap.js")>();
  return {
    ...actual,
    prepareGatewayServerBootstrap: () => {
      throw new Error("fixture preflight failure");
    },
  };
});

describe("createGatewayKernel early startup failure", () => {
  it("preserves an existing gateway's registry and config snapshot", async () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry, "embedded-prior");
    const runningConfig: OpenClawConfig = { channels: {} };
    setRuntimeConfigSnapshot(runningConfig, runningConfig);
    try {
      await expect(createGatewayKernel(0, {})).rejects.toThrow("fixture preflight failure");
      expect(getActivePluginRegistry()).not.toBeNull();
      expect(getRuntimeConfigSnapshot()).toBe(runningConfig);
    } finally {
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
    }
  });
});
