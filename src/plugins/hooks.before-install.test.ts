// Covers hook behavior before plugin install state exists.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeInstallContext,
  PluginHookBeforeInstallEvent,
  PluginHookRegistration,
} from "./types.js";

type BeforeInstallHook = PluginHookRegistration<"before_install">["handler"];

function addBeforeInstallHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: BeforeInstallHook,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "before_install",
    handler,
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
      () => ({
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
      () => ({
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
    const blocker = vi.fn<BeforeInstallHook>(() => ({
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
    }));
    const skipped = vi.fn<BeforeInstallHook>(() => ({
      findings: [
        {
          ruleId: "skipped",
          severity: "warn",
          file: "skip.ts",
          line: 4,
          message: "should not appear",
        },
      ],
    }));

    addBeforeInstallHook(
      registry,
      "plugin-a",
      () => ({
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
