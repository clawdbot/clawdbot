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
const LAZY_GROUP_HELP_CASES = [
  { group: "backup", usageCommand: "backup" },
  { group: "capability", usageCommand: "infer|capability" },
  { group: "channels", usageCommand: "channels" },
  { group: "clawbot", usageCommand: "clawbot" },
  { group: "daemon", usageCommand: "daemon" },
  { group: "hooks", usageCommand: "hooks" },
  { group: "infer", usageCommand: "infer|capability" },
  { group: "migrate", usageCommand: "migrate" },
  { group: "node", usageCommand: "node" },
  { group: "security", usageCommand: "security" },
  { group: "update", usageCommand: "update" },
] as const;

async function createHelpProcessFixture() {
  const root = tempDirs.make("openclaw-help-exit-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const tlsImportGuardPath = path.join(root, "forbid-tls-import.mjs");
  const keepAlivePath = path.join(root, "keep-alive.mjs");
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
  await fs.writeFile(keepAlivePath, "setInterval(() => {}, 60_000);\n");
  return { root, stateDir, configPath, tlsImportGuardPath, keepAlivePath };
}

async function runHelpProcess(params: {
  args: string[];
  forbidTlsImport?: boolean;
  keepAlive?: boolean;
}) {
  const fixture = await createHelpProcessFixture();
  return await execFileAsync(
    process.execPath,
    [
      ...(params.forbidTlsImport
        ? ["--import", pathToFileURL(fixture.tlsImportGuardPath).href]
        : []),
      ...(params.keepAlive ? ["--import", pathToFileURL(fixture.keepAlivePath).href] : []),
      "--import",
      "tsx",
      "src/entry.ts",
      ...params.args,
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fixture.root,
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        NODE_USE_SYSTEM_CA: "1",
        OPENCLAW_CONFIG_PATH: fixture.configPath,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: fixture.stateDir,
        VITEST: undefined,
      },
      killSignal: "SIGKILL",
      timeout: CHILD_PROCESS_TIMEOUT_MS,
    },
  );
}

describe("CLI help process exit", () => {
  it.each([
    { args: ["--help"], usage: "Usage: openclaw [options] [command]" },
    { args: ["path", "--help"], usage: "Usage: openclaw path [options] [command]" },
  ])("exits promptly after $args", async ({ args, usage }) => {
    const result = await runHelpProcess({ args, forbidTlsImport: true });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(usage);
  });

  it.each(LAZY_GROUP_HELP_CASES)("exits promptly after $group --help", async (testCase) => {
    const { group, usageCommand } = testCase;
    const result = await runHelpProcess({ args: [group, "--help"], keepAlive: true });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Usage: openclaw ${usageCommand} [options] [command]`);
  });
});
