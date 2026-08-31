import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runDoctorFix(params: { root: string; configPath: string; loaderPath: string }) {
  const entryPath = fileURLToPath(new URL("../entry.ts", import.meta.url));
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      params.loaderPath,
      entryPath,
      "doctor",
      "--fix",
      "--non-interactive",
      "--no-workspace-suggestions",
      "--no-color",
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: params.root,
        USERPROFILE: params.root,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_ENV: undefined,
        OPENCLAW_CONFIG_PATH: params.configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_HIDE_BANNER: "1",
        OPENCLAW_HOME: undefined,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_STATE_DIR: path.join(params.root, "state"),
        OPENCLAW_TEST_FAST: "1",
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    },
  );
}

describe("Doctor report process output", () => {
  it("reports deferred Doctor-only state after config refusal, then converges", () => {
    const root = tempDirs.make("openclaw-doctor-deferred-state-");
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const configPath = path.join(root, "openclaw.json");
    const workspaceSource = path.join(workspaceDir, "openclaw-workspace-state.json");
    const tuiSource = path.join(stateDir, "tui", "last-session.json");
    const agentSource = path.join(stateDir, "agent", "auth.json");
    const loaderPath = path.join(root, "doctor-test-loader.mjs");
    fs.mkdirSync(path.dirname(tuiSource), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      loaderPath,
      `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/doctor-ui.js")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(
          [
            "export async function detectUiProtocolFreshnessIssues() { return []; }",
            "export function uiProtocolFreshnessIssueToHealthFinding() { return {}; }",
            "export function uiProtocolFreshnessIssueToRepairEffects() { return []; }",
            "export async function maybeRepairUiProtocolFreshness() {}",
          ].join("\\n"),
        ),
      };
    }
    return nextResolve(specifier, context);
  },
});
`,
    );
    const invalidConfig = {
      gatway: { port: 12345 },
      gateway: {
        mode: "remote",
        remote: { url: "ws://127.0.0.1:1", token: "fixture-token" },
      },
      agents: {
        ownership: "explicit",
        defaults: { heartbeat: { every: 5 } },
        entries: {
          primary: { workspace: workspaceDir },
          secondary: {},
        },
      },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(invalidConfig, null, 2)}\n`);
    fs.writeFileSync(
      workspaceSource,
      `${JSON.stringify({ version: 1, setupCompletedAt: "2026-08-01T00:00:00.000Z" })}\n`,
    );
    fs.writeFileSync(
      tuiSource,
      `${JSON.stringify({ global: { sessionKey: "agent:main:main", updatedAt: 1 } })}\n`,
    );
    fs.mkdirSync(path.dirname(agentSource), { recursive: true });
    fs.writeFileSync(agentSource, "{}\n");
    const configBefore = fs.readFileSync(configPath);
    const workspaceBefore = fs.readFileSync(workspaceSource);
    const tuiBefore = fs.readFileSync(tuiSource);
    const agentBefore = fs.readFileSync(agentSource);

    const refused = runDoctorFix({ root, configPath, loaderPath });
    const refusedOutput = `${refused.stderr}\n${refused.stdout}`;

    expect(refused.error, refusedOutput).toBeUndefined();
    expect(refused.signal, refusedOutput).toBeNull();
    expect(refused.status, refusedOutput).toBe(1);
    expect(refusedOutput.match(/Legacy state deferred/g) ?? [], refusedOutput).toHaveLength(1);
    expect(refusedOutput).toContain("Workspace setup and attestations");
    expect(refusedOutput).toContain("TUI last-session pointers");
    expect(refusedOutput).toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(refusedOutput).toContain("No listed legacy source was removed.");
    expect(refusedOutput).toContain('rerun "openclaw doctor --fix"');
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
    expect(fs.readFileSync(workspaceSource)).toEqual(workspaceBefore);
    expect(fs.readFileSync(tuiSource)).toEqual(tuiBefore);
    expect(fs.readFileSync(agentSource)).toEqual(agentBefore);
    expect(fs.readdirSync(workspaceDir)).toEqual(["openclaw-workspace-state.json"]);
    expect(fs.readdirSync(path.dirname(tuiSource))).toEqual(["last-session.json"]);

    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          ...invalidConfig,
          agents: {
            ...invalidConfig.agents,
            defaults: {
              heartbeat: { every: "30m" },
              systemAgent: { agentId: "primary" },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const repaired = runDoctorFix({ root, configPath, loaderPath });
    const repairedOutput = `${repaired.stderr}\n${repaired.stdout}`;
    expect(repaired.error, repairedOutput).toBeUndefined();
    expect(repaired.signal, repairedOutput).toBeNull();
    expect(repaired.status, repairedOutput).toBe(0);
    expect(fs.existsSync(workspaceSource)).toBe(false);
    expect(fs.existsSync(tuiSource)).toBe(false);
    expect(fs.existsSync(agentSource)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "agents", "primary", "agent", "auth.json"))).toBe(
      true,
    );
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).not.toHaveProperty("gatway");

    const clean = runDoctorFix({ root, configPath, loaderPath });
    const cleanOutput = `${clean.stderr}\n${clean.stdout}`;
    expect(clean.error, cleanOutput).toBeUndefined();
    expect(clean.signal, cleanOutput).toBeNull();
    expect(clean.status, cleanOutput).toBe(0);
    expect(cleanOutput).not.toContain("Legacy state deferred");
    expect(cleanOutput).not.toContain("Legacy state detected");
  }, 180_000);

  it("omits backup tips for Git-backed nested agent workspaces", () => {
    const root = tempDirs.make("openclaw-doctor-workspace-git-");
    const repoRoot = path.join(root, "repo");
    const nestedWorkspace = path.join(
      repoRoot,
      ...Array.from({ length: 12 }, (_, index) => `workspace-level-${index}`),
    );
    const linkedWorkspace = path.join(root, "linked-workspace");
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "openclaw.json");
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.mkdirSync(nestedWorkspace, { recursive: true });
    fs.mkdirSync(stateDir);
    fs.symlinkSync(
      nestedWorkspace,
      linkedWorkspace,
      process.platform === "win32" ? "junction" : "dir",
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          ownership: "explicit",
          entries: {
            direct: { workspace: nestedWorkspace },
            linked: { workspace: linkedWorkspace },
          },
        },
      }),
    );

    const entryPath = fileURLToPath(new URL("../entry.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        entryPath,
        "doctor",
        "--lint",
        "--only",
        "core/doctor/workspace-suggestions",
        "--severity-min",
        "info",
        "--json",
        "--no-color",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_HIDE_BANNER: "1",
          OPENCLAW_HOME: root,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: stateDir,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("back up the agent workspace");
    expect(result.stdout).toContain('"target":"direct"');
    expect(result.stdout).toContain('"target":"linked"');
  });

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
