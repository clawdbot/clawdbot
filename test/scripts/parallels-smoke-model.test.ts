// Parallels Smoke Model tests cover parallels smoke model script behavior.
import { EventEmitter } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  modelProviderConfigBatchJson,
  readPositiveIntEnv,
  resolveLatestVersion,
  resolveParallelsModelTimeoutSeconds,
  resolveProviderAuth as resolveProviderAuthDirect,
  resolveSnapshot,
  resolveUbuntuVmName,
  resolveWindowsProviderAuth,
  run,
  runStreaming,
  shellQuote,
  withProgressOnStderr,
} from "../../scripts/e2e/parallels/common.ts";
import { resolveHostCommandInvocation } from "../../scripts/e2e/parallels/host-command.ts";
import { testing as hostServerTesting } from "../../scripts/e2e/parallels/host-server.ts";
import { parseArgs as parseLinuxSmokeArgs } from "../../scripts/e2e/parallels/linux-smoke.ts";
import { parseArgs as parseMacosSmokeArgs } from "../../scripts/e2e/parallels/macos-smoke.ts";
import { parseArgs as parseNpmUpdateSmokeArgs } from "../../scripts/e2e/parallels/npm-update-smoke.ts";
import { PhaseRunner } from "../../scripts/e2e/parallels/phase-runner.ts";
import { parseArgs as parseWindowsSmokeArgs } from "../../scripts/e2e/parallels/windows-smoke.ts";
import { withEnv } from "../../src/test-utils/env.js";
import { spawnNodeEvalSync } from "../../src/test-utils/node-process.js";

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
  smokeCommon: "scripts/e2e/parallels/smoke-common.ts",
  windows: "scripts/e2e/parallels/windows-smoke.ts",
  windowsGit: "scripts/e2e/parallels/windows-git.ts",
};

const OS_TS_PATHS = [TS_PATHS.linux, TS_PATHS.macos, TS_PATHS.windows];

function countNonEmptyLines(value: string): number {
  let count = 0;
  for (const line of value.split("\n")) {
    if (line) {
      count += 1;
    }
  }
  return count;
}

function fakePrlctlEnv(tempDir: string): Record<string, string> {
  const pathValue = `${tempDir}${delimiter}${process.env.Path ?? process.env.PATH ?? ""}`;
  const fakeBootstrap = pathToFileURL(join(tempDir, "prlctl-bootstrap.mjs")).href;
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${fakeBootstrap}`]
    .filter(Boolean)
    .join(" ");
  return { NODE_OPTIONS: nodeOptions, PATH: pathValue, Path: pathValue };
}

function writeFakePrlctl(tempDir: string, posixScript: string, windowsBootstrap: string): void {
  const prlctlPath = join(tempDir, "prlctl");
  writeFileSync(prlctlPath, posixScript);
  chmodSync(prlctlPath, 0o755);
  copyFileSync(process.execPath, join(tempDir, "prlctl.exe"));
  writeFileSync(join(tempDir, "prlctl-bootstrap.mjs"), windowsBootstrap);
}

class FakeHostServerChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    return true;
  }

  exit(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }
  return address.port;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error("condition was not met before timeout");
}

describe("Parallels smoke model selection", () => {
  let invalidProviderResult: ReturnType<typeof spawnNodeEvalSync>;
  let missingProviderKeyResult: ReturnType<typeof spawnNodeEvalSync>;
  let invalidModelTimeoutResult: ReturnType<typeof spawnNodeEvalSync>;
  let invalidHostPortResult: ReturnType<typeof spawnNodeEvalSync>;
  let invalidLinuxAgentTimeoutResult: ReturnType<typeof spawnNodeEvalSync>;
  let invalidWindowsAgentTimeoutResult: ReturnType<typeof spawnNodeEvalSync>;
  let invalidWindowsUpdateTimeoutResult: ReturnType<typeof spawnNodeEvalSync>;

  beforeAll(() => {
    invalidProviderResult = spawnNodeEvalSync(
      `import { parseProvider } from "./${TS_PATHS.common}"; parseProvider("bogus");`,
      { env: process.env, imports: ["tsx"] },
    );
    missingProviderKeyResult = spawnNodeEvalSync(
      `import { resolveProviderAuth } from "./${TS_PATHS.common}"; resolveProviderAuth({ provider: "openai", apiKeyEnv: "PARALLELS_TEST_MISSING_KEY" });`,
      {
        env: { ...process.env, PARALLELS_TEST_MISSING_KEY: "" },
        imports: ["tsx"],
      },
    );
    invalidModelTimeoutResult = spawnNodeEvalSync(
      `process.env.OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S = "1800s"; const { resolveParallelsModelTimeoutSeconds } = await import("./${TS_PATHS.common}"); resolveParallelsModelTimeoutSeconds("macos");`,
      { env: process.env, imports: ["tsx"] },
    );
    invalidHostPortResult = spawnNodeEvalSync(
      `process.argv = ["node", "${TS_PATHS.macos}", "--host-port", "18425x"]; await import("./${TS_PATHS.macos}");`,
      { env: process.env, imports: ["tsx"] },
    );
    invalidLinuxAgentTimeoutResult = spawnNodeEvalSync(
      `process.env.OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S = "1e3"; process.argv = ["node", "${TS_PATHS.linux}"]; await import("./${TS_PATHS.linux}");`,
      { env: process.env, imports: ["tsx"] },
    );
    invalidWindowsAgentTimeoutResult = spawnNodeEvalSync(
      `process.env.OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S = "2700s"; process.argv = ["node", "${TS_PATHS.windows}"]; await import("./${TS_PATHS.windows}");`,
      { env: process.env, imports: ["tsx"] },
    );
    invalidWindowsUpdateTimeoutResult = spawnNodeEvalSync(
      `process.env.OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S = "12.5"; process.argv = ["node", "${TS_PATHS.windows}"]; await import("./${TS_PATHS.windows}");`,
      { env: process.env, imports: ["tsx"] },
    );
  });

  it("keeps the public shell entrypoints as thin TypeScript launchers", () => {
    for (const [platform, wrapperPath] of Object.entries(WRAPPERS)) {
      const wrapper = readFileSync(wrapperPath, "utf8");

      expect(wrapper, wrapperPath).toContain('exec pnpm --dir "$ROOT_DIR" exec tsx');
      if (platform === "npmUpdate") {
        expect(wrapper, wrapperPath).toContain(TS_PATHS.npmUpdate);
      } else {
        expect(wrapper, wrapperPath).toContain(TS_PATHS[platform as "linux" | "macos" | "windows"]);
      }
      expect(countNonEmptyLines(wrapper)).toBeLessThanOrEqual(5);
    }
  });

  it("accepts leading package-manager separators and still honors later terminators", () => {
    expect(parseLinuxSmokeArgs(["--", "--mode", "upgrade"]).mode).toBe("upgrade");
    expect(parseLinuxSmokeArgs(["--mode", "fresh", "--", "--mode", "upgrade"]).mode).toBe("fresh");
    expect(parseMacosSmokeArgs(["--", "--mode", "upgrade"]).mode).toBe("upgrade");
    expect(parseMacosSmokeArgs(["--mode", "fresh", "--", "--mode", "upgrade"]).mode).toBe("fresh");
    expect(parseNpmUpdateSmokeArgs(["--", "--package-spec", "openclaw@2026.5.1"]).packageSpec).toBe(
      "openclaw@2026.5.1",
    );
    expect(
      parseNpmUpdateSmokeArgs([
        "--package-spec",
        "openclaw@2026.5.1",
        "--",
        "--package-spec",
        "openclaw@latest",
      ]).packageSpec,
    ).toBe("openclaw@2026.5.1");
    expect(parseWindowsSmokeArgs(["--", "--upgrade-from-packed-main"]).upgradeFromPackedMain).toBe(
      true,
    );
    expect(
      parseWindowsSmokeArgs(["--mode", "fresh", "--", "--upgrade-from-packed-main"])
        .upgradeFromPackedMain,
    ).toBe(false);
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
    const batch = JSON.parse(modelProviderConfigBatchJson("openai/gpt-5.5", "windows")) as Array<{
      path: string;
      value: unknown;
    }>;

    expect(batch.map((entry) => entry.path)).toContain('agents.defaults.models["openai/gpt-5.5"]');
    expect(JSON.stringify(batch)).not.toContain("agentRuntime");
  });

  it("keeps snapshot, host, package, and quote helpers shared", () => {
    const common = readFileSync(TS_PATHS.common, "utf8");
    const hostCommand = readFileSync(TS_PATHS.hostCommand, "utf8");
    const hostServer = readFileSync(TS_PATHS.hostServer, "utf8");
    const laneRunner = readFileSync(TS_PATHS.laneRunner, "utf8");
    const packageArtifact = readFileSync(TS_PATHS.packageArtifact, "utf8");
    const parallelsVm = readFileSync(TS_PATHS.parallelsVm, "utf8");
    const snapshots = readFileSync(TS_PATHS.snapshots, "utf8");
    const smokeCommon = readFileSync(TS_PATHS.smokeCommon, "utf8");

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
    expect(smokeCommon).toContain("runSmokeLane");
    expect(smokeCommon).toContain("abstract class SmokeRunController");

    for (const scriptPath of OS_TS_PATHS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("resolveSnapshot");
      expect(script, scriptPath).toContain(
        scriptPath === TS_PATHS.macos ? "runSmokeLane" : "SmokeRunController",
      );
      expect(script, scriptPath).not.toContain("def aliases(name: str)");
    }
  });

  it("bounds host artifact server startup stderr", () => {
    const retained = hostServerTesting.appendBoundedOutput(
      "a".repeat(10),
      Buffer.from("b".repeat(10)),
      12,
    );
    expect(retained).toBe(`${"a".repeat(2)}${"b".repeat(10)}`);
  });

  it("keeps JSON-mode progress off stdout", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await withProgressOnStderr(async () => {
        const { say } = await import("../../scripts/e2e/parallels/common.ts");
        say("progress");
        process.stdout.write('{"ok":true}\n');
      });

      expect(stdoutWrite).toHaveBeenCalledTimes(1);
      expect(stdoutWrite).toHaveBeenCalledWith('{"ok":true}\n');
      expect(JSON.parse(String(stdoutWrite.mock.calls[0]?.[0]))).toEqual({ ok: true });
      expect(stderrWrite).toHaveBeenCalledWith("==> progress\n");
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it("waits for host artifact server exit after SIGKILL before stop resolves", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeHostServerChild();
      const stop = hostServerTesting.stopHostServerChild(child as never, 100, 100);
      expect(child.signals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(100);
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

      let resolved = false;
      void stop.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);

      child.exit();
      await expect(stop).resolves.toBe(true);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a temporary npmrc file and cleans it after resolving the latest package version", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-parallels-version-"));
    let userConfigPath = "";
    try {
      const version = resolveLatestVersion("", {
        createTempDir: (prefix) => {
          expect(prefix).toBe(join(tmpdir(), "openclaw-npm-"));
          return mkdtempSync(join(tempRoot, "npm-"));
        },
        runCommand: (command, args, options) => {
          userConfigPath = args.at(-1) ?? "";
          expect(command).toBe("npm");
          expect(args).toEqual(["view", "openclaw", "version", "--userconfig", userConfigPath]);
          expect(options).toEqual({ quiet: true });
          expect(statSync(userConfigPath).isFile()).toBe(true);
          return { status: 0, stderr: "", stdout: "2026.6.1\n" };
        },
      });

      expect(version).toBe("2026.6.1");
      expect(basename(userConfigPath)).toBe("npmrc");
      expect(existsSync(userConfigPath)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "reports only the bounded host artifact server stderr tail",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-host-server-"));
      const fakePython = join(tempDir, "python3");
      writeFileSync(
        fakePython,
        `#!/usr/bin/env bash
set -euo pipefail
printf 'BEGIN_MARKER\\n' >&2
head -c 50000 </dev/zero | tr '\\0' x >&2
printf '\\nTAIL_MARKER\\n' >&2
head -c 30000 </dev/zero | tr '\\0' x >&2
exit 42
`,
      );
      chmodSync(fakePython, 0o755);

      try {
        const port = await unusedLoopbackPort();
        const result = spawnNodeEvalSync(
          `import { startHostServer } from "./${TS_PATHS.hostServer}"; await startHostServer({ dir: ".", hostIp: "127.0.0.1", port: ${port}, artifactPath: "artifact.tgz", label: "artifact" });`,
          {
            env: {
              ...process.env,
              PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
            },
            imports: ["tsx"],
            maxBuffer: 1024 * 1024,
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("host artifact server exited early");
        expect(result.stderr).toContain("TAIL_MARKER");
        expect(result.stderr).not.toContain("BEGIN_MARKER");
        expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(90 * 1024);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it("quotes shell args and resolves fuzzy snapshot hints through the shared TypeScript helper", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-helper-"));
    writeFakePrlctl(
      tempDir,
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
      `import { basename } from "node:path";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  if (process.argv.some((arg) => arg.includes("snapshot-list"))) {
    console.log(JSON.stringify({
      "{older}": { name: "fresh", state: "running" },
      "{wanted}": { name: "fresh-poweroff-2026-04-01", state: "poweroff" },
      "{other}": { name: "unrelated", state: "poweroff" },
    }));
    process.exit(0);
  }
  process.exit(1);
}
`,
    );

    try {
      const output = withEnv(fakePrlctlEnv(tempDir), () => {
        const snapshot = resolveSnapshot("vm", "fresh");
        return `${shellQuote("it's ok")}\n${[snapshot.id, snapshot.state, snapshot.name].join("\t")}`;
      });

      expect(output.split("\n")[0]).toBe("'it'\"'\"'s ok'");
      expect(output).toContain("{wanted}\tpoweroff\tfresh-poweroff-2026-04-01");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("resolves a latest snapshot hint to the matching version before older LATEST labels", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-snapshot-latest-"));
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "snapshot-list" ]]; then
  cat <<'JSON'
{
  "{old}": {"name": "macOS 26.3.1 LATEST", "state": "poweron"},
  "{wanted}": {"name": "macOS 26.5", "state": "poweron"}
}
JSON
  exit 0
fi
exit 1
`,
      `import { basename } from "node:path";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  if (process.argv.some((arg) => arg.includes("snapshot-list"))) {
    console.log(JSON.stringify({
      "{old}": { name: "macOS 26.3.1 LATEST", state: "poweron" },
      "{wanted}": { name: "macOS 26.5", state: "poweron" },
    }));
    process.exit(0);
  }
  process.exit(1);
}
`,
    );

    try {
      const output = withEnv(fakePrlctlEnv(tempDir), () => {
        const snapshot = resolveSnapshot("vm", "macOS 26.5 latest");
        return [snapshot.id, snapshot.state, snapshot.name].join("\t");
      });

      expect(output).toBe("{wanted}\tpoweron\tmacOS 26.5");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("uses one Ubuntu VM fallback resolver for Linux lanes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-vm-helper-"));
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "list" ]]; then
  cat <<'JSON'
[
  {"name": "Ubuntu 26.04"},
  {"name": "Ubuntu 25.10"},
  {"name": "Ubuntu 23.10"},
  {"name": "Ubuntu 24.04.3 ARM64"}
]
JSON
  exit 0
fi
exit 1
`,
      `import { basename } from "node:path";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  if (process.argv.some((arg) => arg.includes("list"))) {
    console.log(JSON.stringify([
      { name: "Ubuntu 26.04" },
      { name: "Ubuntu 25.10" },
      { name: "Ubuntu 23.10" },
      { name: "Ubuntu 24.04.3 ARM64" },
    ]));
    process.exit(0);
  }
  process.exit(1);
}
`,
    );

    try {
      const output = withEnv(fakePrlctlEnv(tempDir), () => resolveUbuntuVmName("Ubuntu missing"));

      expect(output).toBe("Ubuntu 26.04");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("waits for apt locks during Linux snapshot bootstrap", () => {
    const script = readFileSync(TS_PATHS.linux, "utf8");

    expect(script).toContain("DPkg::Lock::Timeout=300");
  });

  it("keeps Linux bad-plugin diagnostics gated for historical update baselines", () => {
    const script = readFileSync(TS_PATHS.linux, "utf8");

    expect(script).toContain('BAD_PLUGIN_DIAGNOSTIC_MIN_VERSION = "2026.5.7"');
    expect(script).toContain("parseOpenClawPackageVersion");
    expect(script).toContain("maybeInjectBadPluginFixture");
    expect(script).toContain("maybeVerifyBadPluginDiagnostic");
    expect(script).toContain("Skipping bad plugin diagnostic fixture");
    expect(script).toContain("Skipping bad plugin diagnostic assertion");
  });

  it("resolves provider defaults and explicit model overrides", () => {
    expect(
      withEnv({ OPENAI_API_KEY: "sk-openai" }, () =>
        resolveProviderAuthDirect({ provider: "openai" }),
      ),
    ).toEqual({
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "sk-openai",
      authChoice: "openai-api-key",
      authKeyFlag: "openai-api-key",
      modelId: "openai/gpt-5.5",
    });

    expect(
      withEnv({ CUSTOM_ANTHROPIC_KEY: "sk-anthropic" }, () =>
        resolveProviderAuthDirect({
          apiKeyEnv: "CUSTOM_ANTHROPIC_KEY",
          modelId: "anthropic/custom",
          provider: "anthropic",
        }),
      ),
    ).toEqual({
      apiKeyEnv: "CUSTOM_ANTHROPIC_KEY",
      apiKeyValue: "sk-anthropic",
      authChoice: "apiKey",
      authKeyFlag: "anthropic-api-key",
      modelId: "anthropic/custom",
    });
  });

  it("uses the shared GPT-5 OpenAI model for Windows smoke unless overridden", () => {
    expect(
      withEnv({ OPENAI_API_KEY: "sk-openai" }, () =>
        resolveWindowsProviderAuth({ provider: "openai" }),
      ),
    ).toEqual({
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "sk-openai",
      authChoice: "openai-api-key",
      authKeyFlag: "openai-api-key",
      modelId: "openai/gpt-5.5",
    });

    expect(
      withEnv(
        {
          OPENAI_API_KEY: "sk-openai",
          OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL: "openai/custom-windows",
        },
        () => resolveWindowsProviderAuth({ provider: "openai" }),
      ),
    ).toEqual({
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "sk-openai",
      authChoice: "openai-api-key",
      authKeyFlag: "openai-api-key",
      modelId: "openai/custom-windows",
    });
  });

  it("rejects invalid providers and missing keys before touching guests", () => {
    expect(invalidProviderResult.status).toBe(1);
    expect(invalidProviderResult.stderr).toContain("invalid --provider: bogus");

    expect(missingProviderKeyResult.status).toBe(1);
    expect(missingProviderKeyResult.stderr).toContain("PARALLELS_TEST_MISSING_KEY is required");
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
      expect(script, scriptPath).toContain("off");
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
    expect(npmUpdateScripts).toContain("--thinking off");
    expect(npmUpdateScripts).toContain("finalAssistant(Raw|Visible)Text");
    expect(npmUpdateScripts).toContain("posixAssertAgentOkScript");
    expect(npmUpdateScripts).toContain("windowsAgentTurnConfigPatchScript");
    expect(npmUpdateScripts).toContain("modelProviderConfigBatchJson");
    expect(npmUpdateScripts).toContain("config set --batch-file");
  });

  it("clears phase timers and applies phase deadlines to guest commands", () => {
    const phaseRunner = readFileSync(TS_PATHS.phaseRunner, "utf8");
    const guestTransports = readFileSync(TS_PATHS.guestTransports, "utf8");
    const parallelsVm = readFileSync(TS_PATHS.parallelsVm, "utf8");
    const snapshots = readFileSync(TS_PATHS.snapshots, "utf8");

    expect(phaseRunner).toContain("clearTimeout(timer)");
    expect(phaseRunner).toContain("remainingTimeoutMs");
    expect(guestTransports).toContain("this.phases.remainingTimeoutMs");
    expect(parallelsVm).toContain("PRLCTL_STATUS_TIMEOUT_MS");
    expect(parallelsVm).toContain("probeTimeoutMs");
    expect(snapshots).toContain("SNAPSHOT_LIST_TIMEOUT_MS");

    for (const scriptPath of OS_TS_PATHS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("PhaseRunner");
      expect(script, scriptPath).toContain("remainingPhaseTimeoutMs");
      expect(script, scriptPath).toContain("timeoutMs:");
    }

    const linux = readFileSync(TS_PATHS.linux, "utf8");
    const macos = readFileSync(TS_PATHS.macos, "utf8");
    const windows = readFileSync(TS_PATHS.windows, "utf8");
    expect(linux).toContain("probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000)");
    expect(windows).toContain("probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000)");
    expect(macos).toContain("probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000)");
    expect(macos).toContain("timeoutMs: this.remainingPhaseTimeoutMs(360_000)");
  });

  it("streams full phase logs to disk while bounding the failure tail", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-phase-"));
    const phaseRunner = new PhaseRunner(runDir, 128);
    const writes: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      await expect(
        phaseRunner.phase("noisy", 30, () => {
          phaseRunner.append(`old-${"x".repeat(256)}`);
          phaseRunner.append("recent failure");
          throw new Error("phase failed");
        }),
      ).rejects.toThrow("phase failed");

      const logText = readFileSync(join(runDir, "noisy.log"), "utf8");
      expect(logText).toContain("old-");
      expect(logText).toContain("recent failure");
      const stderr = writes.join("");
      expect(stderr).toContain("phase log tail truncated");
      expect(stderr).toContain("recent failure");
      expect(stderr).not.toContain(`old-${"x".repeat(200)}`);
    } finally {
      stderrWrite.mockRestore();
      rmSync(runDir, { force: true, recursive: true });
    }
  });

  it("runs POSIX guest shell scripts with a normal install umask", () => {
    const guestTransports = readFileSync(TS_PATHS.guestTransports, "utf8");

    expect(guestTransports.match(/umask 022/g)).toHaveLength(2);
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
    expect(windowsGit.indexOf('"MinGit-2.53.0.2-64-bit.zip"')).toBeLessThan(
      windowsGit.indexOf('"MinGit-2.53.0.2-arm64.zip"'),
    );
    expect(windowsGit).toContain('if "-64-bit." in name:');
    expect(windowsGit).toContain('elif "-arm64." in name:');
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

    expect(script).toContain("scripts/e2e/parallels-${platform}-smoke.sh");
    expect(script).toContain('this.formatRerun("bash", args, env)');
    expect(script).toContain('"--model"');
    expect(script).toContain("auth.modelId");
    expect(script).toContain("authForPlatform");
    expect(script).toContain("OPENCLAW_PARALLELS_LINUX_DISABLE_BONJOUR");
  });

  it("keeps the Windows update config scrub compatible with PowerShell 5.1", () => {
    const script = readFileSync(TS_PATHS.npmUpdateScripts, "utf8");

    expect(script).not.toContain("ConvertFrom-Json -AsHashtable");
    expect(script).toContain("function Get-OpenClawJsonProperty");
    expect(script).toContain("function Remove-OpenClawJsonProperty");
    expect(script).toContain("Remove-OpenClawJsonProperty $entries $pluginId");
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

  it("resolves macOS smoke commands from the guest PATH", () => {
    const macos = readFileSync(TS_PATHS.macos, "utf8");

    expect(macos).toContain("/usr/local/bin:/usr/local/sbin");
    expect(macos).toContain('const guestOpenClaw = "openclaw"');
    expect(macos).toContain('const guestNode = "node"');
    expect(macos).toContain('const guestNpm = "npm"');
    expect(macos).toContain("$(npm root -g)/openclaw/openclaw.mjs");
    expect(macos).toContain("guestOpenClawEntryExec");
    expect(macos).not.toContain('const guestOpenClaw = "/opt/homebrew/bin/openclaw"');
    expect(macos).not.toContain('const guestNode = "/opt/homebrew/bin/node"');
    expect(macos).not.toContain('const guestNpm = "/opt/homebrew/bin/npm"');
    expect(macos).not.toContain("/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs");
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
    const transports = readFileSync(TS_PATHS.guestTransports, "utf8");

    expect(script).toContain("guestPowerShellBackground");
    expect(script).toContain("runWindowsBackgroundPowerShell");
    expect(transports).toContain("Join-Path $env:TEMP");
    expect(transports).toContain("__OPENCLAW_BACKGROUND_DONE__");
    expect(transports).toContain("__OPENCLAW_BACKGROUND_EXIT__");
    expect(transports).toContain("__OPENCLAW_LOG_OFFSET__");
    expect(transports).toContain("poll.status !== 0 && poll.status !== 124");
    expect(transports).toContain("Start-Process -FilePath powershell.exe");
    expect(transports).toContain('launch.stdout.includes("started")');
    expect(transports).toContain("waitForWindowsBackgroundMaterialized");
  });

  it("returns timed-out host command status when check is disabled", () => {
    const result = run(
      process.execPath,
      ["-e", "process.stdout.write('partial'); setTimeout(() => {}, 1000);"],
      {
        check: false,
        quiet: true,
        timeoutMs: 50,
      },
    );

    expect(result.status).toBe(124);
    expect(result.stdout).toBeTypeOf("string");
  });

  it("does not wait for host commands that trap SIGTERM after a timeout", () => {
    const startedAt = Date.now();
    const result = run(
      process.execPath,
      [
        "-e",
        [
          "process.on('SIGTERM', () => {});",
          "setTimeout(() => process.exit(77), 700);",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      {
        check: false,
        quiet: true,
        timeoutMs: 50,
      },
    );

    expect(result.status).toBe(124);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it.runIf(process.platform !== "win32")("throws checked timed host command timeouts", () => {
    expect(() =>
      run(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        quiet: true,
        timeoutMs: 50,
      }),
    ).toThrow(/timed out after 50ms/u);
  });

  it.runIf(process.platform !== "win32")("preserves child exit 124 in timed host commands", () => {
    const result = run(process.execPath, ["-e", "process.exit(124)"], {
      check: false,
      quiet: true,
      timeoutMs: 1_000,
    });

    expect(result.status).toBe(124);
  });

  it.runIf(process.platform !== "win32")(
    "kills timed-out host command process groups",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-host-command-"));
      const scriptPath = join(tempDir, "spawn-grandchild.mjs");
      const grandchildPidPath = join(tempDir, "grandchild.pid");
      let grandchildPid = 0;
      writeFileSync(
        scriptPath,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: "inherit" });
writeFileSync(process.argv[2], String(grandchild.pid));
setInterval(() => {}, 1000);
`,
        "utf8",
      );

      try {
        const result = run(process.execPath, [scriptPath, grandchildPidPath], {
          check: false,
          quiet: true,
          timeoutMs: 500,
        });

        expect(result.status).toBe(124);
        grandchildPid = Number.parseInt(readFileSync(grandchildPidPath, "utf8"), 10);
        expect(Number.isInteger(grandchildPid)).toBe(true);
        await waitFor(() => !isProcessAlive(grandchildPid));
      } finally {
        if (grandchildPid && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("preserves timed host command spawn errors", () => {
    expect(() =>
      run("openclaw-definitely-missing-host-command", [], {
        check: false,
        quiet: true,
        timeoutMs: 50,
      }),
    ).toThrow(/ENOENT/u);
  });

  it("rejects streaming host commands when log writes fail", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-host-command-log-"));
    try {
      await expect(
        runStreaming(process.execPath, ["-e", "process.stdout.write('ok')"], {
          logPath: tempDir,
          quiet: true,
        }),
      ).rejects.toThrow(/failed to write Parallels host command log/u);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not treat timed command stderr as wrapper control data",
    () => {
      const result = run(
        process.execPath,
        ["-e", "process.stderr.write('__OPENCLAW_HOST_COMMAND_SPAWN_ERROR__{}\\n')"],
        {
          check: false,
          quiet: true,
          timeoutMs: 500,
        },
      );

      expect(result.status).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")("preserves timed host command output capture", () => {
    const expected = "x".repeat(256 * 1024);
    const result = run(process.execPath, ["-e", "process.stdout.write('x'.repeat(256 * 1024))"], {
      check: false,
      quiet: true,
      timeoutMs: 1_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it.runIf(process.platform !== "win32")(
    "ignores broken stdin pipes from timed host commands that exit early",
    () => {
      const result = run(process.execPath, ["-e", "process.exit(0)"], {
        check: false,
        input: "x".repeat(1024 * 1024),
        quiet: true,
        timeoutMs: 1_000,
      });

      expect(result.status).toBe(0);
    },
  );

  it("routes Windows host pnpm and npm shims through safe runners", () => {
    const comSpec = "C:\\Windows\\System32\\cmd.exe";

    expect(
      resolveHostCommandInvocation("pnpm", ["build"], {
        env: {
          ComSpec: comSpec,
          npm_execpath: "C:\\Tools\\pnpm.cmd",
        },
        platform: "win32",
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", "C:\\Tools\\pnpm.cmd build"],
      command: comSpec,
      shell: false,
      windowsVerbatimArguments: true,
    });

    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = win32.resolve(win32.dirname(execPath), "npm.cmd");
    expect(
      resolveHostCommandInvocation("npm", ["view", "openclaw", "version"], {
        env: { ComSpec: comSpec },
        execPath,
        existsSync: (candidate) => candidate === npmCmdPath,
        platform: "win32",
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", `${npmCmdPath} view openclaw version`],
      command: comSpec,
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("wraps explicit Windows batch host commands without shell mode", () => {
    expect(
      resolveHostCommandInvocation("C:\\Tools\\helper.cmd", ["@scope/pkg@^1.0.0"], {
        comSpec: "cmd.exe",
        platform: "win32",
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", "C:\\Tools\\helper.cmd @scope/pkg@^^1.0.0"],
      command: "cmd.exe",
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("runs the Windows agent turn through the detached done-file runner", () => {
    const script = readFileSync(TS_PATHS.windows, "utf8");

    expect(script).toContain('guestPowerShellBackground(\n      "agent-turn"');
    expect(script).toContain("OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S");
    expect(script).toContain(
      'readPositiveIntEnv(\n    "OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S"',
    );
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
    expect({
      linux: resolveParallelsModelTimeoutSeconds("linux"),
      macos: resolveParallelsModelTimeoutSeconds("macos"),
      windows: resolveParallelsModelTimeoutSeconds("windows"),
    }).toEqual({
      linux: 900,
      macos: 1800,
      windows: 1800,
    });
    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain(
      'this.agentTimeoutSeconds = readPositiveIntEnv("OPENCLAW_PARALLELS_MACOS_AGENT_TIMEOUT_S", 2700)',
    );
    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain("--timeout ${this.modelTimeoutSeconds}");
    expect(readFileSync(TS_PATHS.linux, "utf8")).toContain(
      '--timeout ${resolveParallelsModelTimeoutSeconds("linux")}',
    );
  });

  it("rejects loose Parallels numeric limits before starting smoke lanes", () => {
    expect(
      withEnv({ OPENCLAW_PARALLELS_MODEL_TIMEOUT_S: "1200" }, () =>
        resolveParallelsModelTimeoutSeconds("linux"),
      ),
    ).toBe(1200);
    expect(
      withEnv({ OPENCLAW_PARALLELS_NUMERIC_TEST: " 42 " }, () =>
        readPositiveIntEnv("OPENCLAW_PARALLELS_NUMERIC_TEST", 7),
      ),
    ).toBe(42);

    expect(invalidModelTimeoutResult.status).toBe(1);
    expect(invalidModelTimeoutResult.stderr).toContain(
      "invalid OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S: 1800s",
    );

    expect(invalidHostPortResult.status).toBe(1);
    expect(invalidHostPortResult.stderr).toContain("invalid --host-port: 18425x");

    expect(invalidLinuxAgentTimeoutResult.status).toBe(1);
    expect(invalidLinuxAgentTimeoutResult.stderr).toContain(
      "invalid OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S: 1e3",
    );

    expect(invalidWindowsAgentTimeoutResult.status).toBe(1);
    expect(invalidWindowsAgentTimeoutResult.stderr).toContain(
      "invalid OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S: 2700s",
    );

    expect(invalidWindowsUpdateTimeoutResult.status).toBe(1);
    expect(invalidWindowsUpdateTimeoutResult.stderr).toContain(
      "invalid OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S: 12.5",
    );

    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain(
      'this.updateDevTimeoutSeconds = readPositiveIntEnv(\n      "OPENCLAW_PARALLELS_MACOS_UPDATE_DEV_TIMEOUT_S"',
    );
    expect(readFileSync(TS_PATHS.linux, "utf8")).toContain(
      'readPositiveIntEnv(\n    "OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S"',
    );
    expect(readFileSync(TS_PATHS.windows, "utf8")).toContain(
      'readPositiveIntEnv(\n    "OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S"',
    );
    expect(readFileSync(TS_PATHS.packageArtifact, "utf8")).toContain(
      'readPositiveIntEnv("OPENCLAW_PARALLELS_PACKAGE_LOCK_TIMEOUT_MS", 30 * 60_000)',
    );
    expect(readFileSync(TS_PATHS.npmUpdate, "utf8")).toContain(
      'readPositiveIntEnv("OPENCLAW_PARALLELS_NPM_UPDATE_TIMEOUT_S", 1200)',
    );
  });

  it("waits through transient Windows restoring state before VM operations", () => {
    const script = readFileSync(TS_PATHS.windows, "utf8");
    const transports = readFileSync(TS_PATHS.guestTransports, "utf8");

    expect(script).toContain("waitForVmNotRestoring");
    expect(script).toContain("snapshot-switch retry");
    expect(transports).toContain("launch retry");
  });

  it("keeps Windows update-only env flags scoped before verification", () => {
    const windows = readFileSync(TS_PATHS.windows, "utf8");
    const powershell = readFileSync(TS_PATHS.powershell, "utf8");

    expect(powershell).toContain("windowsScopedEnvFunction");
    expect(windows).toContain(
      "Invoke-WithScopedEnv @{ OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
    );
    expect(windows).toContain("$script:OpenClawUpdateExit = $LASTEXITCODE");
    expect(windows).not.toContain("$env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'");
  });

  it("writes Parallels phase timing artifacts", () => {
    const phaseRunner = readFileSync(TS_PATHS.phaseRunner, "utf8");
    const npmUpdate = readFileSync(TS_PATHS.npmUpdate, "utf8");

    expect(phaseRunner).toContain("phase-timings.json");
    expect(phaseRunner).toContain("slowest");
    expect(npmUpdate).toContain("timings: this.timings");
    expect(npmUpdate).toContain("recordTiming");
  });

  it("resolves Windows OpenClaw commands without assuming the npm shim path", () => {
    const powershell = readFileSync(TS_PATHS.powershell, "utf8");
    const windows = readFileSync(TS_PATHS.windows, "utf8");

    expect(powershell).toContain("windowsOpenClawResolver");
    expect(powershell).toContain("providerTimeoutConfigJson");
    expect(powershell).toContain("models.providers.${providerId}");
    expect(powershell).toContain("agents.defaults.models${configPathMapKey(modelId)}");
    expect(powershell).toContain("OPENCLAW_PARALLELS_AGENT_RUNTIME_POLICY_SUPPORTED");
    expect(powershell).toContain('selectedModelEntry.agentRuntime = { id: "openclaw" }');
    expect(powershell).toContain("delete selectedModelEntry.agentRuntime");
    expect(powershell).toContain("delete providerEntry.agentRuntime");
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
