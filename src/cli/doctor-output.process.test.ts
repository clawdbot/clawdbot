import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Doctor report process output", () => {
  it.each([
    { name: "advisory JSON", args: ["--json"], exitCode: 0 },
    { name: "lint JSON", args: ["--lint", "--json"], exitCode: 1 },
    { name: "post-upgrade JSON", args: ["--post-upgrade", "--json"], exitCode: 1 },
  ])("drains the whole pipe before exiting for $name", ({ args, exitCode }) => {
    const root = tempDirs.make("openclaw-doctor-output-");
    const payload = { ok: false, findings: [{ level: "error", message: "x".repeat(1024 * 1024) }] };
    const sourceUrl = (relative: string) => new URL(relative, import.meta.url).href;
    // Keep the parser, runtime, and exit lifecycle real. Synthetic report
    // producers exercise the output boundary without accessing operator state.
    const script = `
      import { registerHooks } from "node:module";
      import { Command } from "commander";
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const producer = specifier.endsWith("/doctor-lint.js") ? "lint" :
            specifier.endsWith("/doctor-post-upgrade.js") ? "post-upgrade" : undefined;
          if (producer) {
            const payload = '{ ok: false, findings: [{ level: "error", message: "x".repeat(1024 * 1024) }] }';
            return {
              shortCircuit: true,
              url: "data:text/javascript," + encodeURIComponent(
                producer === "lint"
                  ? 'export async function runDoctorLintCli(runtime) { runtime.writeJson(' + payload + '); return 1; }'
                  : 'export async function runPostUpgradeProbes() { return ' + payload + '; }'
              ),
            };
          }
          return nextResolve(specifier, context);
        },
      });
      const { registerMaintenanceCommands } = await import(${JSON.stringify(sourceUrl("./program/register.maintenance.ts"))});
      const { runCliWithExitFinalization } = await import(${JSON.stringify(sourceUrl("./one-shot-exit.ts"))});
      process.argv = [process.execPath, "openclaw", "doctor", ...${JSON.stringify(args)}];
      await runCliWithExitFinalization({
        run: async () => {
          const program = new Command().name("openclaw");
          registerMaintenanceCommands(program);
          await program.parseAsync(process.argv);
        },
        onError: error => { throw error; },
      });
    `;
    const result = spawnNodeEvalSync(script, {
      imports: ["tsx"],
      env: {
        PATH: path.dirname(process.execPath),
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        NO_COLOR: "1",
      },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(exitCode);
    expect(result.stderr).toBe("");
    const expected = `${JSON.stringify(payload, null, 2)}\n`;
    expect(result.stdout.length).toBe(expected.length);
    expect(result.stdout).toBe(expected);
  });
});
