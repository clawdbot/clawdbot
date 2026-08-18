import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import type { CommandRunner, ResolvedGlobalInstallTarget } from "./update-global.js";

function createInstallTarget(
  manager: "npm" | "pnpm" | "bun",
  globalRoot: string,
): ResolvedGlobalInstallTarget {
  const packageRoot = path.join(globalRoot, "openclaw");
  return {
    manager,
    command: manager,
    globalRoot,
    packageRoot,
    ...(manager === "npm"
      ? { npmOwner: { version: "12.0.0", lifecyclePolicy: "allow-scripts" as const } }
      : {}),
  };
}

describe("OpenClaw source package targets", () => {
  it.each(["npm", "pnpm", "bun"] as const)(
    "refuses official Git source before %s package mutation",
    async (manager) => {
      await withTestDir({ prefix: "openclaw-package-source-target-" }, async (base) => {
        const globalRoot = path.join(base, "global", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const runCommand = vi.fn<CommandRunner>();
        const runStep = vi.fn();

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createInstallTarget(manager, globalRoot),
          installSpec: "github:openclaw/openclaw#main",
          packageName: "openclaw",
          packageRoot,
          runCommand,
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep?.name).toBe("package target validation");
        expect(result.failedStep?.stderrTail).toContain("openclaw update --channel dev");
        expect(result.verifiedPackageRoot).toBe(packageRoot);
        expect(runCommand).not.toHaveBeenCalled();
        expect(runStep).not.toHaveBeenCalled();
      });
    },
  );
});
