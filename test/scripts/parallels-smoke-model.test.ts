import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WRAPPERS = {
  linux: "scripts/e2e/parallels-linux-smoke.sh",
  macos: "scripts/e2e/parallels-macos-smoke.sh",
  npmUpdate: "scripts/e2e/parallels-npm-update-smoke.sh",
  windows: "scripts/e2e/parallels-windows-smoke.sh",
};

const TS_PATHS = {
  agentWorkspace: "scripts/e2e/parallels/agent-workspace.ts",
  common: "scripts/e2e/parallels/common.ts",
  guestTransports: "scripts/e2e/parallels/guest-transports.ts",
  hostCommand: "scripts/e2e/parallels/host-command.ts",
  hostServer: "scripts/e2e/parallels/host-server.ts",
  laneRunner: "scripts/e2e/parallels/lane-runner.ts",
  linux: "scripts/e2e/parallels/linux-smoke.ts",
  macosDiscord: "scripts/e2e/parallels/macos-discord.ts",
  macos: "scripts/e2e/parallels/macos-smoke.ts",
  npmUpdateScripts: "scripts/e2e/parallels/npm-update-scripts.ts",
  npmUpdate: "scripts/e2e/parallels/npm-update-smoke.ts",
  packageArtifact: "scripts/e2e/parallels/package-artifact.ts",
  parallelsVm: "scripts/e2e/parallels/parallels-vm.ts",
  phaseRunner: "scripts/e2e/parallels/phase-runner.ts",
  powershell: "scripts/e2e/parallels/powershell.ts",
  providerAuth: "scripts/e2e/parallels/provider-auth.ts",
  snapshots: "scripts/e2e/parallels/snapshots.ts",
  windows: "scripts/e2e/parallels/windows-smoke.ts",
  windowsGit: "scripts/e2e/parallels/windows-git.ts",
};

const OS_TS_PATHS = [TS_PATHS.linux, TS_PATHS.macos, TS_PATHS.windows];

function runTsEval(source: string, env: Record<string, string> = {}) {
  return execFileSync("node", ["--import", "tsx", "--input-type=module", "--eval", source], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function resolveProviderAuth(
  provider: string,
  options: {
    apiKeyEnv?: string;
    env?: Record<string, string>;
    modelId?: string;
  } = {},
) {
  const source = `
import { resolveProviderAuth } from "./${TS_PATHS.common}";
const result = resolveProviderAuth({
  provider: ${JSON.stringify(provider)},
  apiKeyEnv: ${JSON.stringify(options.apiKeyEnv)},
  modelId: ${JSON.stringify(options.modelId)},
});
console.log(JSON.stringify(result));
`;
  return JSON.parse(runTsEval(source, options.env)) as {
    apiKeyEnv: string;
    apiKeyValue: string;
    authChoice: string;
    authKeyFlag: string;
    modelId: string;
  };
}

describe("Parallels smoke model selection", () => {
  it("keeps the public shell entrypoints as thin TypeScript launchers", () => {
    for (const [platform, wrapperPath] of Object.entries(WRAPPERS)) {
      const wrapper = readFileSync(wrapperPath, "utf8");

      expect(wrapper, wrapperPath).toContain('exec pnpm --dir "$ROOT_DIR" exec tsx');
      if (platform === "npmUpdate") {
        expect(wrapper, wrapperPath).toContain(TS_PATHS.npmUpdate);
      } else {
        expect(wrapper, wrapperPath).toContain(TS_PATHS[platform as "linux" | "macos" | "windows"]);
      }
      expect(wrapper.split("\n").filter(Boolean).length).toBeLessThanOrEqual(5);
    }
  });

  it("keeps provider auth and model defaults in the shared TypeScript helper", () => {
    const providerAuth = readFileSync(TS_PATHS.providerAuth, "utf8");

    expect(providerAuth).toContain("OPENCLAW_PARALLELS_OPENAI_MODEL");
    expect(providerAuth).toContain("OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL");
    expect(providerAuth).toContain("openai/gpt-5.5");
    expect(providerAuth).toContain('authChoice: "openai-api-key"');
    expect(providerAuth).toContain('authChoice: "apiKey"');
    expect(providerAuth).toContain('authChoice: "minimax-global-api"');

    for (const scriptPath of [...OS_TS_PATHS, TS_PATHS.npmUpdate]) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toMatch(/resolve(?:Windows)?ProviderAuth/u);
      expect(script, scriptPath).toContain("--model <provider/model>");
      expect(script, scriptPath).toContain("modelId");
    }
  });

  it("writes full model ids as config map keys in provider batches", () => {
    const source = `
import { modelProviderConfigBatchJson } from "./${TS_PATHS.common}";
const result = modelProviderConfigBatchJson("openai/gpt-5.5", "windows");
console.log(result);
`;
    const batch = JSON.parse(runTsEval(source, { OPENAI_API_KEY: "sk-openai" })) as Array<{
      path: string;
    }>;

    expect(batch.map((entry) => entry.path)).toContain('agents.defaults.models["openai/gpt-5.5"]');
  });

  it("keeps snapshot, host, package, and quote helpers shared", () => {
    const common = readFileSync(TS_PATHS.common, "utf8");
    const hostCommand = readFileSync(TS_PATHS.hostCommand, "utf8");
    const hostServer = readFileSync(TS_PATHS.hostServer, "utf8");
    const laneRunner = readFileSync(TS_PATHS.laneRunner, "utf8");
    const packageArtifact = readFileSync(TS_PATHS.packageArtifact, "utf8");
    const parallelsVm = readFileSync(TS_PATHS.parallelsVm, "utf8");
    const snapshots = readFileSync(TS_PATHS.snapshots, "utf8");

    expect(common).toContain('export * from "./host-command.ts"');
    expect(common).toContain('export * from "./lane-runner.ts"');
    expect(common).toContain('export * from "./package-artifact.ts"');
    expect(common).toContain('export * from "./parallels-vm.ts"');
    expect(common).toContain('export * from "./snapshots.ts"');
    expect(hostCommand).toContain("export function shellQuote");
    expect(laneRunner).toContain("export async function runSmokeLane");
    expect(packageArtifact).toContain("withPackageLock");
    expect(packageArtifact).toContain("Wait for Parallels package lock");
    expect(packageArtifact).toContain("export async function packageVersionFromTgz");
    expect(packageArtifact).toContain("export async function packOpenClaw");
    expect(parallelsVm).toContain("export function resolveUbuntuVmName");
    expect(parallelsVm).toContain("export function waitForVmStatus");
    expect(hostServer).toContain("export async function startHostServer");
    expect(hostServer).toContain("http.server");
    expect(snapshots).toContain("export function resolveSnapshot");

    for (const scriptPath of OS_TS_PATHS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("resolveSnapshot");
      expect(script, scriptPath).toContain("runSmokeLane");
      expect(script, scriptPath).not.toContain("def aliases(name: str)");
    }
  });

  it("quotes shell args and resolves fuzzy snapshot hints through the shared TypeScript helper", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-helper-"));
    const prlctlPath = join(tempDir, "prlctl");
    writeFileSync(
      prlctlPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "snapshot-list" ]]; then
  cat <<'JSON'
{
  "{older}": {"name": "fresh", "state": "running"},
  "{wanted}": {"name": "fresh-poweroff-2026-04-01", "state": "poweroff"},
  "{other}": {"name": "unrelated", "state": "poweroff"}
}
JSON
  exit 0
fi
exit 1
`,
    );
    chmodSync(prlctlPath, 0o755);

    try {
      const output = runTsEval(
        `
import { resolveSnapshot, shellQuote } from "./${TS_PATHS.common}";
console.log(shellQuote("it's ok"));
const snapshot = resolveSnapshot("vm", "fresh");
console.log([snapshot.id, snapshot.state, snapshot.name].join("\\t"));
`,
        { PATH: `${tempDir}:${process.env.PATH ?? ""}` },
      );

      expect(output.split("\n")[0]).toBe("'it'\"'\"'s ok'");
      expect(output).toContain("{wanted}\tpoweroff\tfresh-poweroff-2026-04-01");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("uses one Ubuntu VM fallback resolver for Linux lanes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-vm-helper-"));
    const prlctlPath = join(tempDir, "prlctl");
    writeFileSync(
      prlctlPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "list" ]]; then
  cat <<'JSON'
[
  {"name": "Ubuntu 25.10"},
  {"name": "Ubuntu 23.10"},
  {"name": "Ubuntu 24.04.3 ARM64"}
]
JSON
  exit 0
fi
exit 1
`,
    );
    chmodSync(prlctlPath, 0o755);

    try {
      const output = runTsEval(
        `
import { resolveUbuntuVmName } from "./${TS_PATHS.common}";
console.log(resolveUbuntuVmName("Ubuntu missing"));
`,
        { PATH: `${tempDir}:${process.env.PATH ?? ""}` },
      );

      expect(output.trim()).toBe("Ubuntu 24.04.3 ARM64");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("waits for apt locks during Linux snapshot bootstrap", () => {
    const script = readFileSync(TS_PATHS.linux, "utf8");

    expect(script).toContain("DPkg::Lock::Timeout=300");
  });

  it("resolves provider defaults and explicit model overrides", () => {
    expect(resolveProviderAuth("openai", { env: { OPENAI_API_KEY: "sk-openai" } })).toEqual({
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "sk-openai",
      authChoice: "openai-api-key",
      authKeyFlag: "openai-api-key",
      modelId: "openai/gpt-5.5",
    });

    expect(
      resolveProviderAuth("anthropic", {
        apiKeyEnv: "CUSTOM_ANTHROPIC_KEY",
        env: { CUSTOM_ANTHROPIC_KEY: "sk-anthropic" },
        modelId: "anthropic/custom",
      }),
    ).toEqual({
      apiKeyEnv: "CUSTOM_ANTHROPIC_KEY",
      apiKeyValue: "sk-anthropic",
      authChoice: "apiKey",
      authKeyFlag: "anthropic-api-key",
      modelId: "anthropic/custom",
    });
  });

  it("uses the shared GPT-5 OpenAI model for Windows smoke unless overridden", () => {
    const source = `
import { resolveWindowsProviderAuth } from "./${TS_PATHS.common}";
const result = resolveWindowsProviderAuth({
  provider: "openai",
});
console.log(JSON.stringify(result));
`;
    expect(JSON.parse(runTsEval(source, { OPENAI_API_KEY: "sk-openai" }))).toMatchObject({
      apiKeyEnv: "OPENAI_API_KEY",
      modelId: "openai/gpt-5.5",
    });

    expect(
      JSON.parse(
        runTsEval(source, {
          OPENAI_API_KEY: "sk-openai",
          OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL: "openai/custom-windows",
        }),
      ),
    ).toMatchObject({
      modelId: "openai/custom-windows",
    });
  });

  it("rejects invalid providers and missing keys before touching guests", () => {
    const invalidProvider = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { parseProvider } from "./${TS_PATHS.common}"; parseProvider("bogus");`,
      ],
      { encoding: "utf8", env: process.env },
    );
    expect(invalidProvider.status).toBe(1);
    expect(invalidProvider.stderr).toContain("invalid --provider: bogus");

    const missingKey = spawnSync(
      "node",
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { resolveProviderAuth } from "./${TS_PATHS.common}"; resolveProviderAuth({ provider: "openai", apiKeyEnv: "PARALLELS_TEST_MISSING_KEY" });`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PARALLELS_TEST_MISSING_KEY: "" },
      },
    );
    expect(missingKey.status).toBe(1);
    expect(missingKey.stderr).toContain("PARALLELS_TEST_MISSING_KEY is required");
  });

  it("seeds agent workspace state before OS smoke agent turns", () => {
    const workspace = readFileSync(TS_PATHS.agentWorkspace, "utf8");

    expect(workspace).toContain("workspace-state.json");
    expect(workspace).toContain("IDENTITY.md");
    expect(workspace).toContain("BOOTSTRAP.md");

    for (const scriptPath of OS_TS_PATHS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("AgentWorkspaceScript");
      expect(script, scriptPath).toContain("parallels-");
      if (scriptPath !== TS_PATHS.windows) {
        expect(script, scriptPath).toContain("agents.defaults.skipBootstrap");
        expect(script, scriptPath).toContain("tools.profile");
      }
      expect(script, scriptPath).toContain("--thinking");
      expect(script, scriptPath).toContain("minimal");
      expect(script, scriptPath).toContain("finalAssistant(Raw|Visible)Text");
    }
    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain("modelProviderConfigBatchJson");
    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain("config set --batch-file");
    expect(readFileSync(TS_PATHS.linux, "utf8")).toContain("modelProviderConfigBatchJson");
    expect(readFileSync(TS_PATHS.linux, "utf8")).toContain("config set --batch-file");
    expect(readFileSync(TS_PATHS.windows, "utf8")).toContain("windowsAgentTurnConfigPatchScript");
    const powershell = readFileSync(TS_PATHS.powershell, "utf8");
    expect(powershell).toContain("config set --batch-file");
    expect(powershell).toContain("agents.defaults.skipBootstrap");
    expect(powershell).toContain("tools.profile");
    expect(powershell).toContain("replace(/^\\\\uFEFF/u");

    const npmUpdateScripts = readFileSync(TS_PATHS.npmUpdateScripts, "utf8");
    expect(npmUpdateScripts).toContain("posixAgentWorkspaceScript");
    expect(npmUpdateScripts).toContain("windowsAgentWorkspaceScript");
    expect(npmUpdateScripts).toContain("tools.profile");
    expect(npmUpdateScripts).toContain("--thinking minimal");
    expect(npmUpdateScripts).toContain("finalAssistant(Raw|Visible)Text");
    expect(npmUpdateScripts).toContain("posixAssertAgentOkScript");
    expect(npmUpdateScripts).toContain("windowsAgentTurnConfigPatchScript");
    expect(npmUpdateScripts).toContain("modelProviderConfigBatchJson");
    expect(npmUpdateScripts).toContain("config set --batch-file");
  });

  it("clears phase timers and applies phase deadlines to guest commands", () => {
    const phaseRunner = readFileSync(TS_PATHS.phaseRunner, "utf8");
    const guestTransports = readFileSync(TS_PATHS.guestTransports, "utf8");

    expect(phaseRunner).toContain("clearTimeout(timer)");
    expect(phaseRunner).toContain("remainingTimeoutMs");
    expect(guestTransports).toContain("this.phases.remainingTimeoutMs");

    for (const scriptPath of OS_TS_PATHS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("PhaseRunner");
      expect(script, scriptPath).toContain("remainingPhaseTimeoutMs");
      expect(script, scriptPath).toContain("timeoutMs:");
    }
  });

  it("provisions portable Git before Windows dev update lanes", () => {
    const script = readFileSync(TS_PATHS.windows, "utf8");
    const windowsGit = readFileSync(TS_PATHS.windowsGit, "utf8");
    const combined = `${script}\n${windowsGit}`;

    expect(script).toContain("prepareMinGitZip");
    expect(script).toContain("ensureGuestGit");
    expect(script).toContain("fresh.ensure-git");
    expect(script).toContain("upgrade.ensure-git");
    expect(combined).toContain("MinGit-");
    expect(combined).toContain("portable-git");
    expect(combined).toContain("where.exe git.exe");
  });

  it("preseeds dev update channel before stable-to-dev update lanes", () => {
    const macos = readFileSync(TS_PATHS.macos, "utf8");
    const windows = readFileSync(TS_PATHS.windows, "utf8");

    expect(macos).toContain('channel: "dev"');
    expect(windows).toContain("Name channel -Value 'dev'");
    expect(macos).toContain("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1");
    expect(windows).toContain("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS");
  });

  it("passes aggregate model overrides into each OS fresh lane", () => {
    const script = readFileSync(TS_PATHS.npmUpdate, "utf8");

    expect(script).toContain("scripts/e2e/parallels/${platform}-smoke.ts");
    expect(script).toContain('"--model"');
    expect(script).toContain("auth.modelId");
    expect(script).toContain("authForPlatform");
    expect(script).toContain("OPENCLAW_PARALLELS_LINUX_DISABLE_BONJOUR");
  });

  it("keeps aggregate update guest scripts isolated from the npm-update orchestrator", () => {
    const orchestrator = readFileSync(TS_PATHS.npmUpdate, "utf8");
    const updateScripts = readFileSync(TS_PATHS.npmUpdateScripts, "utf8");

    expect(orchestrator).toContain("macosUpdateScript");
    expect(orchestrator).toContain("windowsUpdateScript");
    expect(orchestrator).toContain("linuxUpdateScript");
    expect(orchestrator).not.toContain("Remove-FuturePluginEntries");
    expect(updateScripts).toContain("Remove-FuturePluginEntries");
    expect(updateScripts).toContain("scrub_future_plugin_entries");
    expect(updateScripts).toContain("Invoke-OpenClaw update");
    expect(updateScripts).toContain("Parallels npm update smoke test assistant.");
  });

  it("keeps macOS Discord roundtrip isolated from the lane orchestrator", () => {
    const macos = readFileSync(TS_PATHS.macos, "utf8");
    const discord = readFileSync(TS_PATHS.macosDiscord, "utf8");

    expect(macos).toContain("MacosDiscordSmoke");
    expect(macos).not.toContain("Authorization: Bot");
    expect(discord).toContain("Authorization: Bot");
    expect(discord).toContain('"--silent"');
    expect(discord).toContain("doctor --fix --yes --non-interactive");
    expect(discord).toContain("channels status --probe --json");
    expect(discord).toContain("Stop ${this.input.vmName} after successful Discord smoke");
  });

  it("keeps Windows gateway reachability on a real deadline with start recovery", () => {
    const script = readFileSync(TS_PATHS.windows, "utf8");

    expect(script).toContain("OPENCLAW_PARALLELS_WINDOWS_GATEWAY_RECOVERY_AFTER_S");
    expect(script).toContain("Date.now() < deadline");
    expect(script).toContain("gateway start");
    expect(script).toContain("gateway-reachable recovery");
  });

  it("runs Windows ref onboarding through a detached done-file runner", () => {
    const script = readFileSync(TS_PATHS.windows, "utf8");

    expect(script).toContain("guestPowerShellBackground");
    expect(script).toContain("Join-Path $env:TEMP");
    expect(script).toContain("__OPENCLAW_BACKGROUND_DONE__");
    expect(script).toContain("__OPENCLAW_BACKGROUND_EXIT__");
    expect(script).toContain("__OPENCLAW_LOG_OFFSET__");
    expect(script).toContain("result.status !== 0 && result.status !== 124");
    expect(script).toContain("Start-Process -FilePath powershell.exe");
    expect(script).toContain('launchLog.includes("started")');
    expect(script).toContain("waitForBackgroundMaterialized(pathsScript, 45_000)");
  });

  it("returns timed-out host command status when check is disabled", () => {
    const result = JSON.parse(
      runTsEval(`
import { run } from "./${TS_PATHS.hostCommand}";
const result = run(process.execPath, ["-e", "process.stdout.write('partial'); setTimeout(() => {}, 1000);"], {
  check: false,
  quiet: true,
  timeoutMs: 50,
});
console.log(JSON.stringify(result));
`),
    ) as { status: number; stdout: string };

    expect(result.status).toBe(124);
    expect(result.stdout).toEqual(expect.any(String));
  });

  it("runs the Windows agent turn through the detached done-file runner", () => {
    const script = readFileSync(TS_PATHS.windows, "utf8");

    expect(script).toContain('guestPowerShellBackground(\n      "agent-turn"');
    expect(script).toContain("OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S");
    expect(script).toContain("OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S || 2700");
    expect(script).toContain("windowsAgentTurnConfigPatchScript(this.auth.modelId)");
    expect(script).toContain("--model");
    expect(script).toContain('resolveParallelsModelTimeoutSeconds("windows")');
    expect(script).toContain("finalAssistant(Raw|Visible)Text");
    expect(script).toContain("parallels-windows-smoke-retry-$attempt");
    expect(script).toContain("agent turn attempt $attempt failed or finished without OK response");
    expect(script).not.toContain("$config.models.providers");
    expect(script).not.toContain("timeoutSeconds = 300");
    expect(script).toContain('"$sessionId.jsonl"');
  });

  it("gives GPT-5.5 enough Parallels model time on slower desktop guests", () => {
    const source = `
import { resolveParallelsModelTimeoutSeconds } from "./${TS_PATHS.common}";
console.log(JSON.stringify({
  macos: resolveParallelsModelTimeoutSeconds("macos"),
  windows: resolveParallelsModelTimeoutSeconds("windows"),
  linux: resolveParallelsModelTimeoutSeconds("linux"),
}));
`;
    expect(JSON.parse(runTsEval(source))).toEqual({
      linux: 900,
      macos: 1800,
      windows: 1800,
    });
    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain(
      "OPENCLAW_PARALLELS_MACOS_AGENT_TIMEOUT_S || 2700",
    );
    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain(
      '--timeout ${resolveParallelsModelTimeoutSeconds("macos")}',
    );
    expect(readFileSync(TS_PATHS.linux, "utf8")).toContain(
      '--timeout ${resolveParallelsModelTimeoutSeconds("linux")}',
    );
  });

  it("waits through transient Windows restoring state before VM operations", () => {
    const script = readFileSync(TS_PATHS.windows, "utf8");

    expect(script).toContain("waitForVmNotRestoring");
    expect(script).toContain("snapshot-switch retry");
    expect(script).toContain("launch retry");
  });

  it("resolves Windows OpenClaw commands without assuming the npm shim path", () => {
    const powershell = readFileSync(TS_PATHS.powershell, "utf8");
    const windows = readFileSync(TS_PATHS.windows, "utf8");

    expect(powershell).toContain("windowsOpenClawResolver");
    expect(powershell).toContain("providerTimeoutConfigJson");
    expect(powershell).toContain("models.providers.${providerId}");
    expect(powershell).toContain("agents.defaults.models${configPathMapKey(modelId)}");
    expect(powershell).toContain("configPathMapKey");
    expect(powershell).toContain('transport: "sse"');
    expect(powershell).toContain("Resolve-OpenClawCommand");
    expect(powershell).toContain("npm\\node_modules\\openclaw\\openclaw.mjs");
    expect(powershell).toContain("$ErrorActionPreference = 'Continue'");
    expect(powershell).toContain("$PSNativeCommandUseErrorActionPreference = $false");
    expect(windows).toContain("windowsOpenClawResolver");
    expect(windows).toContain("Invoke-OpenClaw gateway");
    expect(windows).not.toContain("Join-Path $env:APPDATA 'npm\\\\openclaw.cmd'");
  });
});
