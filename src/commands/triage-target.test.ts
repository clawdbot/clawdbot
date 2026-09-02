import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveExecPreparedRunEnvironment,
  resolvePreparedExecEnvironment,
} from "../agents/bash-tools.exec-request-preparation.js";
import {
  getRuntimeConfig,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import { pinRuntimePaths, resolveStateDir } from "../config/paths.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import {
  getInstallationTarget,
  resolveInstallationTarget,
  withInstallationTarget,
} from "../infra/installation-target-context.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as agentExec from "./agent-exec.js";
import { triageCommand } from "./triage.js";

const mocks = vi.hoisted(() => ({
  collectDoctorFindings: vi.fn(),
  writeDiagnosticSupportExport: vi.fn(),
  verifySetupInference: vi.fn(),
  agentCommand: vi.fn(),
}));

// Diagnostics and inference are fixture leaves; triage, exec, config, env filtering,
// and child processes stay real so the handoff cannot hide behind an exec mock.
vi.mock("./doctor-lint.js", () => ({ collectDoctorFindings: mocks.collectDoctorFindings }));
vi.mock("../logging/diagnostic-support-export.js", () => ({
  writeDiagnosticSupportExport: mocks.writeDiagnosticSupportExport,
}));
vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInference: mocks.verifySetupInference,
}));
vi.mock("./agent.js", () => ({ agentCommand: mocks.agentCommand }));

const execFileAsync = promisify(execFile);
const pathsModuleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../config/paths.ts")).href;
const workspaceModuleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../agents/workspace-default.ts"),
).href;
const tsxApiUrl = import.meta.resolve("tsx/esm/api");
const tsconfigPath = path.resolve(import.meta.dirname, "../../tsconfig.json");
const marker = "synthetic-original-installation";
const secret = "sk-test-triage-target-synthetic-secret-1234567890";

type ChildTarget = {
  stateDir: string;
  configPath: string;
  configExists: boolean;
  marker?: string;
  defaultWorkspaceDir: string;
  workspaceMarker?: string;
};

async function inspectChildTarget(env: NodeJS.ProcessEnv, cwd: string): Promise<ChildTarget> {
  // Load only the real CLI path owner, never a CLI entrypoint, Doctor, or an agent.
  const source = `
    import { existsSync, readFileSync } from "node:fs";
    import path from "node:path";
    const { register } = await import(${JSON.stringify(tsxApiUrl)});
    const unregister = register({ tsconfig: ${JSON.stringify(tsconfigPath)} });
    const { resolveStateDir, resolveConfigPath } = await import(${JSON.stringify(pathsModuleUrl)});
    const { resolveDefaultAgentWorkspaceDir } = await import(${JSON.stringify(workspaceModuleUrl)});
    const stateDir = resolveStateDir();
    const configPath = resolveConfigPath();
    const defaultWorkspaceDir = resolveDefaultAgentWorkspaceDir();
    const workspaceMarkerPath = path.join(defaultWorkspaceDir, "workspace-probe.txt");
    process.stdout.write(JSON.stringify({ stateDir, configPath, configExists: existsSync(configPath), marker: existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")).meta?.lastTouchedVersion : undefined, defaultWorkspaceDir, workspaceMarker: existsSync(workspaceMarkerPath) ? readFileSync(workspaceMarkerPath, "utf8") : undefined }));
    await unregister();
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    { cwd, env, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  return JSON.parse(stdout) as ChildTarget;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  pinRuntimePaths();
});

describe.skipIf(process.platform === "win32")("embedded triage installation target", () => {
  it.each([
    { name: "sandbox all", agent: { sandbox: { mode: "all" as const } } },
    { name: "sandbox non-main", agent: { sandbox: { mode: "non-main" as const } } },
    { name: "node", agent: { tools: { exec: { host: "node" as const } } } },
    { name: "explicit sandbox", agent: { tools: { exec: { host: "sandbox" as const } } } },
  ])("refuses $name before the fixing turn, without changing ordinary exec", async ({ agent }) => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "diagnostic" } },
          entries: { diagnostic: agent },
        },
      };
      setRuntimeConfigSnapshot(config);
      const runAgent = vi.fn(async () => ({
        payloads: [{ text: "fixture completed" }],
        meta: { durationMs: 1 },
      }));
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const target = resolveInstallationTarget();
      const result = await withInstallationTarget(target, () =>
        agentExec.agentExecCommand("inspect", { cwd: state.workspaceDir }, runtime, { runAgent }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.envelope.error?.message).toContain("saved prompt");
      expect(runAgent).not.toHaveBeenCalled();
      expect(getInstallationTarget()).toBeUndefined();
      expect(getRuntimeConfigSnapshot()).toBe(config);
      const ordinary = await agentExec.agentExecCommand(
        "inspect",
        { cwd: state.workspaceDir },
        runtime,
        { runAgent },
      );
      expect(ordinary.exitCode).toBe(0);
      expect(runAgent).toHaveBeenCalledOnce();
    });
  });
  it.each([
    { layout: "split" as const, fails: false, workspaceSelector: "custom" },
    { layout: "home" as const, fails: false, workspaceSelector: "default" },
    { layout: "split" as const, fails: true, workspaceSelector: "default" },
  ])(
    "keeps the $layout installation and $workspaceSelector workspace addressable (fails=$fails)",
    async ({ layout, fails, workspaceSelector }) => {
      const previousSnapshot = getRuntimeConfigSnapshot();
      const temporaryRoot = os.tmpdir();
      // Clear inherited credentials and selectors through the tracked helper. Only
      // synthetic paths and a fake provider key reach the production env boundary.
      const syntheticEnv: Record<string, string | undefined> = Object.fromEntries(
        Object.keys(process.env).map((key) => [key, undefined]),
      );
      Object.assign(syntheticEnv, {
        PATH: "/usr/bin:/bin",
        TMPDIR: temporaryRoot,
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
        VITEST: "true",
        NODE_ENV: "test",
        OPENAI_API_KEY: secret,
        OPENCLAW_WORKSPACE_DIR: undefined,
      });
      try {
        await withEnvAsync(syntheticEnv, async () => {
          await withOpenClawTestState(
            {
              layout,
              label: "triage-target",
              ...(layout === "home"
                ? { env: { OPENCLAW_STATE_DIR: undefined, OPENCLAW_CONFIG_PATH: undefined } }
                : {}),
            },
            async (state) => {
              vi.spyOn(process, "cwd").mockReturnValue(state.workspaceDir);
              const defaultWorkspaceDir =
                workspaceSelector === "custom"
                  ? state.path("custom default workspace")
                  : state.statePath("workspace");
              if (workspaceSelector === "custom") {
                process.env.OPENCLAW_WORKSPACE_DIR = defaultWorkspaceDir;
              }
              await fs.mkdir(defaultWorkspaceDir, { recursive: true });
              const workspaceMarkerPath = path.join(defaultWorkspaceDir, "workspace-probe.txt");
              await fs.writeFile(workspaceMarkerPath, marker);
              const terminalDescriptors = [process.stdin, process.stdout].map((stream) =>
                Object.getOwnPropertyDescriptor(stream, "isTTY"),
              );
              for (const stream of [process.stdin, process.stdout]) {
                Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
              }
              try {
                await state.writeConfig({
                  meta: { lastTouchedVersion: marker },
                  agents: {
                    ownership: "explicit",
                    defaults: { systemAgent: { agentId: "diagnostic" } },
                    entries: {
                      diagnostic: {
                        model: "fixture/diagnostic-model",
                        runtime: { type: "acp" },
                      },
                    },
                  },
                  env: { shellEnv: { enabled: false } },
                  plugins: { enabled: false },
                  gateway: { auth: { mode: "token", token: secret } },
                });
                const originalConfig = await fs.readFile(state.configPath, "utf8");
                const archivePath = state.statePath("logs", "support", "installation.zip");
                const archive = await new JSZip()
                  .file("installation.txt", marker)
                  .generateAsync({ type: "nodebuffer" });
                await fs.mkdir(path.dirname(archivePath), { recursive: true });
                await fs.writeFile(archivePath, archive);
                mocks.collectDoctorFindings.mockResolvedValue([
                  {
                    checkId: "fixture/installation",
                    severity: "warning",
                    message: `Synthetic diagnostic; Authorization: Bearer ${secret}`,
                  },
                ]);
                mocks.writeDiagnosticSupportExport.mockResolvedValue({ path: archivePath });
                mocks.verifySetupInference.mockResolvedValue({ ok: true });
                const runtime = {
                  log: vi.fn(),
                  error: vi.fn(),
                  exit: vi.fn(),
                  writeStdout: vi.fn(),
                };
                const execSpy = vi.spyOn(agentExec, "agentExecCommand");
                const before = await inspectChildTarget(sanitizeHostExecEnv(), state.workspaceDir);
                expect(before).toEqual({
                  stateDir: state.stateDir,
                  configPath: state.configPath,
                  configExists: true,
                  marker,
                  defaultWorkspaceDir,
                  workspaceMarker: marker,
                });
                if (layout === "split") {
                  expect(path.dirname(state.configPath)).not.toBe(state.stateDir);
                }
                const originalSelectors = {
                  stateDir: process.env.OPENCLAW_STATE_DIR,
                  configPath: process.env.OPENCLAW_CONFIG_PATH,
                  workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
                };

                let runStateDir = "";
                let shellLookup = "";
                let childTarget: ChildTarget | undefined;
                mocks.agentCommand.mockImplementation(async (opts: Record<string, unknown>) => {
                  const prompt = String(opts.message);
                  const archiveReference = /^Sanitized ZIP: (.+)$/mu.exec(prompt)?.[1];
                  expect(archiveReference).toBe(
                    "$OPENCLAW_STATE_DIR/logs/support/installation.zip",
                  );
                  expect(prompt).not.toContain(secret);
                  expect(prompt).not.toContain(state.stateDir);
                  expect(prompt).not.toContain(defaultWorkspaceDir);
                  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8 * 1024);
                  runStateDir = await fs.realpath(resolveStateDir());
                  expect(runStateDir).not.toBe(state.stateDir);
                  const runConfig = getRuntimeConfig();
                  expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe(state.workspaceDir);
                  expect(runConfig.agents?.entries?.diagnostic?.workspace).toBe(state.workspaceDir);
                  expect(runConfig.agents?.entries?.diagnostic?.model).toBe(
                    "fixture/diagnostic-model",
                  );
                  const sessionStore = resolveSessionStorePathCore(runConfig.session?.store, {
                    agentId: String(opts.agentId),
                  });
                  expect(sessionStore).toBe(
                    path.join(runStateDir, "agents", "diagnostic", "sessions", "sessions.json"),
                  );
                  expect(opts.sessionId).toEqual(expect.any(String));
                  // Exercise the same preparation and projection used by built-in exec;
                  // no installation selectors are supplied by the probe itself.
                  const prepared = resolveExecPreparedRunEnvironment({
                    config: runConfig,
                    agentId: "diagnostic",
                  });
                  const { env: toolEnv } = resolvePreparedExecEnvironment({
                    execParams: { command: "synthetic read-only target probes" },
                    host: "gateway",
                    defaultPathPrepend: [],
                    warnings: [],
                    ...prepared,
                  });
                  expect(toolEnv.OPENAI_API_KEY).toBeUndefined();
                  const shell = await execFileAsync(
                    "/bin/sh",
                    [
                      "-c",
                      `archive="${archiveReference}"; printf '%s\\n' "$archive"; if [ -f "$archive" ]; then printf 'present\\n'; else printf 'missing\\n'; fi`,
                    ],
                    { env: toolEnv, cwd: state.workspaceDir, encoding: "utf8", timeout: 10_000 },
                  );
                  shellLookup = shell.stdout;
                  childTarget = await inspectChildTarget(toolEnv, state.workspaceDir);
                  if (fails) {
                    throw new Error("synthetic run failure");
                  }
                  return {
                    payloads: [{ text: "Synthetic boundary probes completed." }],
                    meta: { durationMs: 1 },
                  };
                });

                if (fails) {
                  await expect(triageCommand(runtime, { run: true })).rejects.toMatchObject({
                    code: 1,
                  });
                } else {
                  await triageCommand(runtime, { run: true });
                }

                expect(runtime.error.mock.calls).toEqual(fails ? [["synthetic run failure"]] : []);
                expect(runtime.exit.mock.calls).toEqual(fails ? [[1]] : []);
                expect(getInstallationTarget()).toBeUndefined();
                expect(mocks.agentCommand).toHaveBeenCalledOnce();
                expect(execSpy).toHaveBeenCalledOnce();
                expect(execSpy.mock.calls[0]?.[1].stateDir).toBeUndefined();
                expect(process.env.OPENCLAW_STATE_DIR).toBe(originalSelectors.stateDir);
                expect(process.env.OPENCLAW_CONFIG_PATH).toBe(originalSelectors.configPath);
                expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe(originalSelectors.workspaceDir);
                expect(getRuntimeConfigSnapshot()).toBeNull();
                await expect(fs.stat(runStateDir)).rejects.toMatchObject({ code: "ENOENT" });
                expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
                expect(await fs.readFile(archivePath)).toEqual(archive);
                expect(await fs.readFile(workspaceMarkerPath, "utf8")).toBe(marker);
                expect(JSON.stringify(runtime.log.mock.calls)).not.toContain(secret);

                // Assert only after exec's cleanup, so both failures preserve the
                // ephemeral-run invariant and report the two lost target boundaries.
                expect
                  .soft(shellLookup, "shell must find the archive named in the model prompt")
                  .toBe(`${archivePath}\npresent\n`);
                expect
                  .soft(
                    childTarget,
                    "child OpenClaw must select the original config and default workspace",
                  )
                  .toEqual(before);
              } finally {
                for (const [index, stream] of [process.stdin, process.stdout].entries()) {
                  const descriptor = terminalDescriptors[index];
                  if (descriptor) {
                    Object.defineProperty(stream, "isTTY", descriptor);
                  } else {
                    Reflect.deleteProperty(stream, "isTTY");
                  }
                }
                vi.restoreAllMocks();
              }
            },
          );
        });
      } finally {
        if (previousSnapshot) {
          setRuntimeConfigSnapshot(previousSnapshot);
        }
        pinRuntimePaths();
      }
    },
  );
});
