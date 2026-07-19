// Process coverage for help rendering without loading live Gateway transports.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CHILD_PROCESS_TIMEOUT_MS = 30_000;

describe("CLI help process exit", () => {
  it.each([
    { args: ["--help"], usage: "Usage: openclaw [options] [command]" },
    { args: ["path", "--help"], usage: "Usage: openclaw path [options] [command]" },
  ])("exits promptly after $args", async ({ args, usage }) => {
    const root = tempDirs.make("openclaw-help-exit-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const tlsImportGuardPath = path.join(root, "forbid-tls-import.mjs");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ plugins: { entries: { "oc-path": { enabled: true } } } }),
    );
    await fs.writeFile(
      tlsImportGuardPath,
      `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "node:tls" || specifier === "tls") {
      throw new Error(\`CLI help imported TLS from \${context.parentURL ?? "unknown"}\`);
    }
    return nextResolve(specifier, context);
  },
});
`,
    );

    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        pathToFileURL(tlsImportGuardPath).href,
        "--import",
        "tsx",
        "src/entry.ts",
        ...args,
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          NODE_USE_SYSTEM_CA: "1",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: stateDir,
          VITEST: undefined,
        },
        killSignal: "SIGKILL",
        timeout: CHILD_PROCESS_TIMEOUT_MS,
      },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(usage);
  });
});
