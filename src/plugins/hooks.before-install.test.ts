// Covers hook behavior before plugin install state exists.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeInstallContext,
  PluginHookBeforeInstallEvent,
  PluginHookBeforeInstallResult,
  PluginHookRegistration,
} from "./types.js";

function addBeforeInstallHook(
  registry: PluginRegistry,
  pluginId: string,
  handler:
    | (() => PluginHookBeforeInstallResult | Promise<PluginHookBeforeInstallResult>)
    | PluginHookRegistration["handler"],
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "before_install",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

const stubCtx: PluginHookBeforeInstallContext = {
  origin: "openclaw-workspace",
  targetType: "skill",
  requestKind: "skill-install",
};

const stubEvent: PluginHookBeforeInstallEvent = {
  targetName: "demo-skill",
  targetType: "skill",
  sourcePath: "/tmp/demo-skill",
  sourcePathKind: "directory",
  origin: "openclaw-workspace",
  request: {
    kind: "skill-install",
    mode: "install",
  },
  builtinScan: {
    status: "ok",
    scannedFiles: 1,
    critical: 0,
    warn: 0,
    info: 0,
    findings: [],
  },
  skill: {
    installId: "deps",
  },
};

describe("before_install hook merger", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("accumulates findings across handlers in priority order", async () => {
    addBeforeInstallHook(
      registry,
      "plugin-a",
      (): PluginHookBeforeInstallResult => ({
        findings: [
          {
            ruleId: "first",
            severity: "warn",
            file: "a.ts",
            line: 1,
            message: "first finding",
          },
        ],
      }),
      100,
    );
    addBeforeInstallHook(
      registry,
      "plugin-b",
      (): PluginHookBeforeInstallResult => ({
        findings: [
          {
            ruleId: "second",
            severity: "critical",
            file: "b.ts",
            line: 2,
            message: "second finding",
          },
        ],
      }),
      50,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeInstall(stubEvent, stubCtx);

    expect(result).toEqual({
      findings: [
        {
          ruleId: "first",
          severity: "warn",
          file: "a.ts",
          line: 1,
          message: "first finding",
        },
        {
          ruleId: "second",
          severity: "critical",
          file: "b.ts",
          line: 2,
          message: "second finding",
        },
      ],
      block: undefined,
      blockReason: undefined,
    });
  });

  it("short-circuits after block=true and preserves earlier findings", async () => {
    const blocker = vi.fn(
      (): PluginHookBeforeInstallResult => ({
        findings: [
          {
            ruleId: "blocker",
            severity: "critical",
            file: "block.ts",
            line: 3,
            message: "blocked finding",
          },
        ],
        block: true,
        blockReason: "policy blocked",
      }),
    );
    const skipped = vi.fn(
      (): PluginHookBeforeInstallResult => ({
        findings: [
          {
            ruleId: "skipped",
            severity: "warn",
            file: "skip.ts",
            line: 4,
            message: "should not appear",
          },
        ],
      }),
    );

    addBeforeInstallHook(
      registry,
      "plugin-a",
      (): PluginHookBeforeInstallResult => ({
        findings: [
          {
            ruleId: "first",
            severity: "warn",
            file: "a.ts",
            line: 1,
            message: "first finding",
          },
        ],
      }),
      100,
    );
    addBeforeInstallHook(registry, "plugin-block", blocker, 50);
    addBeforeInstallHook(registry, "plugin-skipped", skipped, 10);

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeInstall(stubEvent, stubCtx);

    expect(result).toEqual({
      findings: [
        {
          ruleId: "first",
          severity: "warn",
          file: "a.ts",
          line: 1,
          message: "first finding",
        },
        {
          ruleId: "blocker",
          severity: "critical",
          file: "block.ts",
          line: 3,
          message: "blocked finding",
        },
      ],
      block: true,
      blockReason: "policy blocked",
    });
    expect(blocker).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
  });
});
