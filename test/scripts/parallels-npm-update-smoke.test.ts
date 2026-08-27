// Parallels Npm Update Smoke tests cover parallels npm update smoke script behavior.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  posixAgentWorkspaceScript,
  windowsAgentWorkspaceScript,
} from "../../scripts/e2e/parallels/agent-workspace.ts";
import { runWindowsBackgroundPowerShell } from "../../scripts/e2e/parallels/guest-transports.ts";
import { run as hostCommandRun } from "../../scripts/e2e/parallels/host-command.ts";
import {
  linuxUpdateScript,
  macosUpdateScript,
  windowsUpdateScript,
} from "../../scripts/e2e/parallels/npm-update-scripts.ts";
import {
  freshLaneTimeoutMs,
  NpmUpdateSmoke,
  parseRegistryPackageMetadata,
  parseArgs,
  spawnLoggedCommand,
} from "../../scripts/e2e/parallels/npm-update-smoke.ts";
import type { HostServer, Platform } from "../../scripts/e2e/parallels/types.ts";
import { withEnv, withEnvAsync } from "../../src/test-utils/env.js";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/parallels/npm-update-smoke.ts";
const GUEST_TRANSPORTS_PATH = "scripts/e2e/parallels/guest-transports.ts";
const UPDATE_SCRIPTS_PATH = "scripts/e2e/parallels/npm-update-scripts.ts";
const TEST_AUTH = {
  authChoice: "openai",
  authKeyFlag: "--openai-api-key",
  apiKeyEnv: "OPENAI_API_KEY",
  apiKeyValue: "test-key",
  modelId: "gpt-5.4",
};
const tempDirs = createTempDirTracker();

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`timeout waiting for pid ${pid} to exit`);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`timeout waiting for ${label}`);
}

function decodePowerShellFromArgs(args: string[]): string {
  const encoded = args[args.indexOf("-EncodedCommand") + 1];
  return encoded ? Buffer.from(encoded, "base64").toString("utf16le") : "";
}

function extractWindowsBackgroundControlMarkers(decoded: string): {
  done: string;
  exitPrefix: string;
} {
  const marker = (name: string, trailingColon: boolean): string => {
    const suffix = trailingColon ? ":" : "";
    const match = decoded.match(new RegExp(`${name}:[A-Za-z0-9_-]+${suffix}`));
    if (!match) {
      throw new Error(`missing ${name} control marker`);
    }
    return match[0];
  };
  return {
    done: marker("__OPENCLAW_BACKGROUND_DONE__", false),
    exitPrefix: marker("__OPENCLAW_BACKGROUND_EXIT__", true),
  };
}

afterEach(() => {
  vi.useRealTimers();
  tempDirs.cleanup();
});

describe("parallels npm update smoke", () => {
  it("accepts one prepared tarball target for update and fresh install", () => {
    expect(
      parseArgs([
        "--target-tarball",
        "/tmp/openclaw-candidate.tgz",
        "--dependency-tarball",
        "/tmp/openclaw-ai-candidate.tgz",
        "--registry-package-tarball",
        "/tmp/openclaw-codex-candidate.tgz",
      ]),
    ).toMatchObject({
      dependencyTarballs: ["/tmp/openclaw-ai-candidate.tgz"],
      registryPackageTarballs: ["/tmp/openclaw-codex-candidate.tgz"],
      targetTarball: "/tmp/openclaw-candidate.tgz",
      updateTarget: "",
      freshTargetSpec: undefined,
    });
    expect(() =>
      parseArgs(["--target-tarball", "/tmp/openclaw-candidate.tgz", "--update-target", "beta"]),
    ).toThrow("--target-tarball cannot be combined");
    expect(() => parseArgs(["--dependency-tarball", "/tmp/openclaw-ai-candidate.tgz"])).toThrow(
      "--dependency-tarball requires --target-tarball",
    );
    expect(() =>
      parseArgs(["--registry-package-tarball", "/tmp/openclaw-codex-candidate.tgz"]),
    ).toThrow("--registry-package-tarball requires --target-tarball");
  });

  it("passes an explicit macOS snapshot hint through fresh lanes", () => {
    expect(
      parseArgs(["--platform", "macos", "--macos-snapshot-hint", "macOS 26.5 Node 24"]),
    ).toMatchObject({
      macosSnapshotHint: "macOS 26.5 Node 24",
      platforms: new Set(["macos"]),
    });
  });

  it("accepts an explicit Windows VM at the aggregate CLI", () => {
    const result = hostCommandRun(
      process.execPath,
      ["--import", "tsx", SCRIPT_PATH, "--windows-vm", "Windows Test Guest", "--help"],
      { check: false, quiet: true },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "uses the selected Windows VM for same-guest update transport",
    async () => {
      const root = tempDirs.make("openclaw-parallels-windows-selection-");
      const logPath = path.join(root, "prlctl.log");
      const prlctlPath = path.join(root, "prlctl");
      writeFileSync(
        prlctlPath,
        `#!/usr/bin/env bash\nprintf '%s|%s|%s\\n' "$1" "$2" "$3" >'${logPath}'\ncat >/dev/null\nexit 7\n`,
      );
      chmodSync(prlctlPath, 0o755);

      await withEnvAsync(
        { OPENAI_API_KEY: "test-key", PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}` },
        async () => {
          const smoke = new NpmUpdateSmoke({ ...parseArgs([]), windowsVm: "Windows Test Guest" });
          const guestWindows = Reflect.get(smoke, "guestWindows") as (
            script: string,
            timeoutMs: number,
            ctx: { append: (chunk: string) => void },
          ) => Promise<void>;
          await expect(
            guestWindows.call(smoke, "Write-Output update", 180_000, { append: () => undefined }),
          ).rejects.toThrow("background script write failed");
        },
      );
      expect(readFileSync(logPath, "utf8")).toBe("exec|Windows Test Guest|--current-user\n");
    },
  );

  it("stops the host artifact server when the wrapper fails mid-run", async () => {
    let stopCalls = 0;
    const server: HostServer = {
      hostIp: "127.0.0.1",
      port: 48123,
      stop: async () => {
        stopCalls += 1;
      },
      urlFor: (filePath) => `http://127.0.0.1:48123/${path.basename(filePath)}`,
    };

    class FailingNpmUpdateSmoke extends NpmUpdateSmoke {
      protected override async makeRunTempDir(prefix: string): Promise<string> {
        void prefix;
        return tempDirs.make("openclaw-parallels-npm-update-");
      }

      protected override async runSteps(): Promise<void> {
        this.server = server;
        throw new Error("forced wrapper failure");
      }
    }

    await withEnvAsync({ OPENAI_API_KEY: "test-key" }, async () => {
      const smoke = new FailingNpmUpdateSmoke({
        ...TEST_AUTH,
        dependencyTarballs: [],
        registryPackageTarballs: [],
        json: false,
        packageSpec: "openclaw@latest",
        platforms: new Set<Platform>(["linux"]),
        provider: "openai",
        updateTarget: "local-main",
      });

      await expect(smoke.run()).rejects.toThrow("forced wrapper failure");
    });

    expect(stopCalls).toBe(1);
  });

  it("removes uploaded guest update scripts when chmod fails", () => {
    const root = tempDirs.make("openclaw-parallels-npm-update-");
    const logPath = path.join(root, "prlctl.log");
    const prlctlPath = path.join(root, "prlctl");
    writeFileSync(
      prlctlPath,
      `#!/usr/bin/env bash
set -euo pipefail
log_path=${JSON.stringify(logPath)}
printf '%s\\n' "$*" >>"$log_path"
args=" $* "
if [[ "$args" == *" /usr/bin/tee /tmp/openclaw-parallels-npm-update-linux-"* ]]; then
  cat >/dev/null
  exit 0
fi
if [[ "$args" == *" /bin/chmod 755 /tmp/openclaw-parallels-npm-update-linux-"* ]]; then
  echo "chmod denied" >&2
  exit 7
fi
if [[ "$args" == *" /bin/rm -f /tmp/openclaw-parallels-npm-update-linux-"* ]]; then
  printf 'cleanup\\n' >>"$log_path"
  exit 0
fi
exit 1
`,
    );
    chmodSync(prlctlPath, 0o755);

    withEnv(
      {
        OPENAI_API_KEY: "test-key",
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      () => {
        const smoke = new NpmUpdateSmoke({
          ...TEST_AUTH,
          dependencyTarballs: [],
          registryPackageTarballs: [],
          json: false,
          packageSpec: "openclaw@latest",
          platforms: new Set<Platform>(["linux"]),
          provider: "openai",
          updateTarget: "local-main",
        });
        const writeGuestScript = Reflect.get(smoke, "writeGuestScript") as (
          vm: string,
          script: string,
          prefix: string,
        ) => string;

        expect(() =>
          writeGuestScript.call(
            smoke,
            "Linux VM",
            "echo update",
            "openclaw-parallels-npm-update-linux",
          ),
        ).toThrow("failed to chmod guest script");
      },
    );

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("/bin/chmod 755 /tmp/openclaw-parallels-npm-update-linux-");
    expect(log).toContain("/bin/rm -f /tmp/openclaw-parallels-npm-update-linux-");
    expect(log.match(/^cleanup$/gm)).toHaveLength(1);
  });

  it("uses one macOS guest identity to write and execute update scripts", async () => {
    const root = tempDirs.make("openclaw-parallels-npm-update-");
    const logPath = path.join(root, "prlctl.log");
    const prlctlPath = path.join(root, "prlctl");
    writeFileSync(
      prlctlPath,
      `#!/usr/bin/env bash
set -euo pipefail
log_path=${JSON.stringify(logPath)}
printf '%s\\n' "$*" >>"$log_path"
args=" $* "
if [[ "$args" == *" --current-user whoami "* ]]; then
  printf 'desktop-user\\n'
  exit 0
fi
if [[ "$args" == *" /usr/bin/tee /tmp/openclaw-parallels-npm-update-macos-"* ]]; then
  cat >/dev/null
  exit 0
fi
if [[ "$args" == *" /bin/chmod 700 /tmp/openclaw-parallels-npm-update-macos-"* ]]; then
  exit 0
fi
if [[ "$args" == *" /usr/sbin/chown desktop-user /tmp/openclaw-parallels-npm-update-macos-"* ]]; then
  exit 0
fi
if [[ "$args" == *" /bin/rm -f /tmp/openclaw-parallels-npm-update-macos-"* ]]; then
  exit 0
fi
exit 1
`,
    );
    chmodSync(prlctlPath, 0o755);

    await withEnvAsync(
      {
        OPENAI_API_KEY: "test-key",
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      async () => {
        const smoke = new NpmUpdateSmoke({
          ...TEST_AUTH,
          dependencyTarballs: [],
          registryPackageTarballs: [],
          json: false,
          packageSpec: "openclaw@latest",
          platforms: new Set<Platform>(["macos"]),
          provider: "openai",
          updateTarget: "local-main",
        });
        const stream = vi.fn().mockResolvedValue(0);
        Reflect.set(smoke, "runStreamingToJobLog", stream);
        const guestMacos = Reflect.get(smoke, "guestMacos") as (
          script: string,
          timeoutMs: number,
          ctx: { append: (chunk: string) => void },
        ) => Promise<void>;
        const ctx = { append: vi.fn() };

        await guestMacos.call(smoke, "echo update", 30_000, ctx);

        const call = stream.mock.calls.at(0);
        expect(call?.[0]).toBe("prlctl");
        expect(call?.[1]).toEqual([
          "exec",
          "macOS Tahoe",
          "--current-user",
          "/usr/bin/env",
          expect.stringMatching(/^PATH=/),
          "/bin/bash",
          expect.stringMatching(/^\/tmp\/openclaw-parallels-npm-update-macos-/),
        ]);
      },
    );

    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("--current-user whoami");
    expect(log).toContain("--current-user /usr/bin/env PATH=");
    expect(log).toContain("/usr/bin/tee /tmp/openclaw-parallels-npm-update-macos-");
    expect(log).toContain("/bin/chmod 700 /tmp/openclaw-parallels-npm-update-macos-");
    expect(log).toContain("/usr/sbin/chown desktop-user");
  });

  it("has a one-command beta validation mode with fresh target coverage", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("--beta-validation [target]");
    expect(script).toContain("resolveOpenClawRegistryVersion");
    expect(script).toContain("this.options.updateTarget = version");
    expect(script).toContain("this.options.freshTargetSpec = `openclaw@${version}`");
    expect(script).toContain("runFreshTargetInstalls");
    expect(script).toContain("freshTargetStatus");
  });

  it.runIf(process.platform !== "win32").each([
    ["macos", macosUpdateScript],
    ["linux", linuxUpdateScript],
  ] as const)(
    "keeps the %s candidate registry available through gateway shutdown and the local turn",
    (platform, buildScript) => {
      const root = tempDirs.make("openclaw-parallels-update-registry-");
      const logPath = path.join(root, "registry.log");
      const lifecycleLog = path.join(root, "lifecycle.log");
      const gatewayOwner = path.join(root, "gateway-owner");
      const gatewayTitle = platform === "macos" ? "openclaw-gateway        " : "openclaw-gateway";
      const registry = "http://192.0.2.2:48123";
      const script = buildScript({
        auth: TEST_AUTH,
        expectedNeedle: "2026.7.1-beta.3",
        npmRegistry: registry,
        updateTarget: "2026.7.1-beta.3",
      }).replaceAll(
        `/tmp/openclaw-parallels-${platform}-gateway.log`,
        path.join(root, "gateway.log"),
      );
      const result = hostCommandRun(
        "bash",
        [
          "-c",
          `
export HOME='${root}'
unset OPENCLAW_WORKSPACE_DIR
node() { cat >/dev/null; }
python3() { cat >/dev/null; }
function /usr/bin/env() { cat >/dev/null; }
release_gateway_owner() {
  if [ -f '${gatewayOwner}' ]; then
    printf 'stop\\n' >>'${lifecycleLog}'
    rm '${gatewayOwner}'
  fi
}
pkill() {
  if [ "$1" = '-f' ] && printf '%s\\n' '${gatewayTitle}' | grep -Eq "$2"; then
    release_gateway_owner
  else
    return 1
  fi
}
pgrep() { return 1; }
lsof() { :; }
sleep() { :; }
setsid() { :; }
openclaw() {
  case "$1 \${2-}" in
    "gateway stop")
      if [[ " $* " == *" --help "* ]]; then echo '--force'; return 0; fi
      release_gateway_owner
      return 0 ;;
    "gateway status")
      touch '${gatewayOwner}'
      printf 'ready\\n' >>'${lifecycleLog}' ;;
    "agent --local")
      if [ -f '${gatewayOwner}' ]; then echo 'gateway owns state' >&2; return 73; fi
      printf 'local-turn\\n' >>'${lifecycleLog}'
      echo '{"finalAssistantVisibleText":"OK"}' ;;
    "gateway run"|"models set"|"config set") return 0 ;;
  esac
  printf '%s|%s|%s\\n' "$1" "\${NPM_CONFIG_REGISTRY-}" "\${npm_config_registry-}" >>'${logPath}'
  case "$1" in
    --version) echo 'OpenClaw 2026.7.1-beta.3' ;;
  esac
}
${script}`,
        ],
        { check: false, quiet: true, timeoutMs: 5000 },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
        `update|${registry}|${registry}`,
        `--version|${registry}|${registry}`,
        `gateway|${registry}|${registry}`,
        `agent|${registry}|${registry}`,
      ]);
      expect(readFileSync(lifecycleLog, "utf8").trim().split("\n")).toEqual([
        "ready",
        "stop",
        "local-turn",
      ]);
    },
  );

  it("restarts POSIX gateways only after an exact current-launch migration refusal", () => {
    const input = {
      auth: TEST_AUTH,
      expectedNeedle: "2026.7.2-beta.5",
      updateTarget: "2026.7.2-beta.5",
    };

    for (const script of [macosUpdateScript(input), linuxUpdateScript(input)]) {
      expect(script).toContain(
        "OpenClaw plugin migration inputs changed during startup convergence;",
      );
      expect(script).toContain("gateway_launch_log_offset=");
      expect(script).toContain("gateway_pid=$!");
      expect(script).toContain('if ! kill -0 "$gateway_pid" 2>/dev/null; then');
      expect(script).toContain('tail -c +"$((gateway_launch_log_offset + 1))" "$gateway_log"');
      expect(script).toContain(
        'if [ "$gateway_exit_status" -le 128 ] && [ "$gateway_restart_count" -eq 0 ]; then',
      );
      expect(script).toContain("gateway_restart_count=1");
      expect(script).not.toContain('if [ "$attempt" -eq 4 ]');
    }
  });

  it("restarts the Windows gateway only after its current launch exits with the exact refusal", () => {
    const script = windowsUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.7.2-beta.5",
      updateTarget: "2026.7.2-beta.5",
    });

    expect(script).toContain(
      "OpenClaw plugin migration inputs changed during startup convergence;",
    );
    expect(script).toContain("$script:gatewayProcess.HasExited");
    expect(script).toContain("$script:gatewayProcess.WaitForExit()");
    expect(script).toContain("$script:gatewayRestartCount -eq 0");
    expect(script).toContain("Test-CurrentGatewayStartupMigrationRefusal");
    expect(script).toContain("Select-String -Path $script:gatewayLogPath -SimpleMatch");
    expect(script).toContain("$script:gatewayRestartCount = 1");
    expect(script).not.toContain("$attempt -eq 4");
    expect(script).not.toContain("Invoke-OpenClaw gateway restart");
  });

  it("keeps POSIX provider secrets out of executable command lines", () => {
    const input = {
      auth: TEST_AUTH,
      expectedNeedle: "2026.7.2-beta.5",
      updateTarget: "2026.7.2-beta.5",
    };
    const exportLine = `  export ${TEST_AUTH.apiKeyEnv}='${TEST_AUTH.apiKeyValue}'`;

    for (const script of [macosUpdateScript(input), linuxUpdateScript(input)]) {
      expect(script.split("\n").filter((line) => line.includes(TEST_AUTH.apiKeyValue))).toEqual([
        exportLine,
      ]);
      expect(script).toMatch(/with_provider_api_key [^\n]*gateway run/u);
      expect(script).toMatch(/with_provider_api_key [^\n]*agent --local/u);
      expect(script).toContain(`unset ${TEST_AUTH.apiKeyEnv}`);
      expect(script.split("\n").find((line) => line.includes(" update --tag "))).not.toContain(
        "with_provider_api_key",
      );
    }
  });

  it("does not recreate retired workspace setup state in release smoke scripts", () => {
    const input = {
      auth: TEST_AUTH,
      expectedNeedle: "2026.7.2-beta.2",
      updateTarget: "2026.7.2-beta.2",
    };

    for (const script of [macosUpdateScript(input), linuxUpdateScript(input)]) {
      expect(script).toContain("IDENTITY.md");
      expect(script).not.toContain("workspace-state.json");
    }
    expect(windowsUpdateScript(input)).toContain("IDENTITY.md");
    expect(windowsUpdateScript(input)).not.toContain("workspace-state.json");

    expect(posixAgentWorkspaceScript("test")).not.toContain("workspace-state.json");
    expect(windowsAgentWorkspaceScript("test")).not.toContain("workspace-state.json");
  });

  it("accepts keyed and nested npm metadata for published update targets", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("curl -fsSL --connect-timeout 10 --max-time 120 --retry 2");
    expect(script).toContain("timeoutMs: 150_000");

    expect(
      parseRegistryPackageMetadata(
        JSON.stringify({
          version: "2026.5.20-beta.1",
          "dist.tarball": "https://registry.example/openclaw-keyed.tgz",
          gitHead: "abcdef0123456789",
        }),
      ),
    ).toEqual({
      version: "2026.5.20-beta.1",
      tarball: "https://registry.example/openclaw-keyed.tgz",
      gitHead: "abcdef0123456789",
    });

    expect(
      parseRegistryPackageMetadata(
        JSON.stringify({
          version: "2026.5.20-beta.1",
          dist: { tarball: "https://registry.example/openclaw-nested.tgz" },
        }),
      ),
    ).toEqual({
      version: "2026.5.20-beta.1",
      tarball: "https://registry.example/openclaw-nested.tgz",
      gitHead: "",
    });
  });

  it("guards beta validation against cross-version harness checkouts", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("assertPublishedTargetMatchesHarnessCheckout");
    expect(script).toContain("readHarnessCheckoutVersion");
    expect(script).toContain("openClawVersionFamily");
    expect(script).toContain("OPENCLAW_PARALLELS_ALLOW_HARNESS_TARGET_MISMATCH");
    expect(script).toContain("checkout the matching release branch");
  });

  it("lets callers override the Parallels host IP", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("--host-ip <ip>");
    expect(script).toContain("hostIp?: string");
    expect(script).toContain("options.hostIp = ensureValue");
    expect(script).toContain('resolveHostIp(this.options.hostIp ?? "")');
  });

  it("prints actionable progress, rerun hints, and markdown summaries", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("stale=");
    expect(script).toContain("bytes=");
    expect(script).toContain("rerunCommand");
    expect(script).toContain("writeSummaryMarkdown");
    expect(script).toContain("Parallels NPM Update Smoke");
  });

  it("streams aggregate update logs instead of retaining them in memory", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const updateBlock = script.slice(
      script.indexOf("  private spawnUpdate"),
      script.indexOf("  private async runMacosUpdate"),
    );

    expect(updateBlock).toContain("appendFileSync(logPath, text");
    expect(updateBlock).toContain("run: ({ signal }) => fn({ append, logPath, signal })");
    expect(updateBlock).not.toContain("log += text");
  });

  it("bounds POSIX guest failure logs", () => {
    const scripts = [
      macosUpdateScript({
        auth: TEST_AUTH,
        expectedNeedle: "2026.5.3-beta.2",
        updateTarget: "2026.5.3-beta.2",
      }),
      linuxUpdateScript({
        auth: TEST_AUTH,
        expectedNeedle: "2026.5.3-beta.2",
        updateTarget: "2026.5.3-beta.2",
      }),
    ].join("\n");

    expect(scripts).toContain("print_log_tail()");
    expect(scripts).toContain("OPENCLAW_PARALLELS_NPM_UPDATE_LOG_TAIL_BYTES");
    expect(scripts).toContain('print_log_tail "$output_file"');
    expect(scripts).toContain('print_log_tail "$gateway_log" >&2');
    expect(scripts).not.toContain('cat "$output_file"');
    expect(scripts).not.toContain("cat /tmp/openclaw-parallels-");
  });

  it("passes platform model timeouts to POSIX update agent turns", () => {
    const input = {
      auth: TEST_AUTH,
      expectedNeedle: "2026.5.3-beta.2",
      updateTarget: "2026.5.3-beta.2",
    };
    withEnv(
      {
        OPENCLAW_PARALLELS_LINUX_MODEL_TIMEOUT_S: undefined,
        OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S: undefined,
        OPENCLAW_PARALLELS_MODEL_TIMEOUT_S: undefined,
      },
      () => {
        expect(macosUpdateScript(input)).toContain("--timeout 1800 --json");
        expect(linuxUpdateScript(input)).toContain("--timeout 900 --json");
      },
    );
    withEnv(
      {
        OPENCLAW_PARALLELS_LINUX_MODEL_TIMEOUT_S: "321",
        OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S: "654",
      },
      () => {
        expect(macosUpdateScript(input)).toContain("--timeout 654 --json");
        expect(linuxUpdateScript(input)).toContain("--timeout 321 --json");
      },
    );
  });

  it("streams fresh lane logs instead of retaining them in memory", async () => {
    const root = tempDirs.make("openclaw-parallels-npm-update-");
    const logPath = path.join(root, "fresh.log");
    const output: string[] = [];

    const code = await spawnLoggedCommand(
      process.execPath,
      ["-e", "process.stdout.write('fresh-out'); process.stderr.write('fresh-err');"],
      logPath,
      {},
      (text) => output.push(text),
      { timeoutMs: 1000 },
    );

    expect(code).toBe(0);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("fresh-out");
    expect(log).toContain("fresh-err");
    expect(output.join("")).toContain("fresh-out");
    expect(output.join("")).toContain("fresh-err");
  });

  it("sets platform-aware fresh lane timeouts", () => {
    withEnv({ OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S: undefined }, () => {
      expect(freshLaneTimeoutMs("macos")).toBe(75 * 60 * 1000);
      expect(freshLaneTimeoutMs("linux")).toBe(75 * 60 * 1000);
      expect(freshLaneTimeoutMs("windows")).toBe(90 * 60 * 1000);
    });

    withEnv({ OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S: "3" }, () => {
      expect(freshLaneTimeoutMs("macos")).toBe(3000);
    });

    withEnv(
      { OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S: String(Number.MAX_SAFE_INTEGER) },
      () => {
        expect(freshLaneTimeoutMs("linux")).toBe(MAX_TIMER_TIMEOUT_MS);
      },
    );
  });

  it("clamps oversized fresh lane command timeouts before scheduling", async () => {
    const root = tempDirs.make("openclaw-parallels-npm-update-");
    const logPath = path.join(root, "fresh.log");

    const code = await spawnLoggedCommand(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 25);"],
      logPath,
      {},
      undefined,
      { timeoutMs: Number.MAX_SAFE_INTEGER },
    );

    expect(code).toBe(0);
  });

  it.runIf(process.platform !== "win32")("times out fresh lane process groups", async () => {
    const root = tempDirs.make("openclaw-parallels-npm-update-");
    const logPath = path.join(root, "fresh.log");
    const scriptPath = path.join(root, "hung-fresh-lane.mjs");
    const descendantPidPath = path.join(root, "descendant.pid");
    const descendantScript = [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    writeFileSync(
      scriptPath,
      [
        "import { spawn } from 'node:child_process';",
        `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
          descendantScript,
        )}], { stdio: "ignore" });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const code = await spawnLoggedCommand(process.execPath, [scriptPath], logPath, {}, undefined, {
      timeoutKillGraceMs: 25,
      timeoutLabel: "fresh lane test",
      timeoutMs: 250,
    });

    expect(code).toBe(124);
    expect(readFileSync(logPath, "utf8")).toContain("fresh lane test timed out after 250ms");
    expect(existsSync(descendantPidPath)).toBe(true);
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    await waitForDead(descendantPid, 2000);
  });

  it.runIf(process.platform !== "win32")(
    "lets fresh lane descendants exit during timeout kill grace",
    async () => {
      const root = tempDirs.make("openclaw-parallels-npm-update-");
      const logPath = path.join(root, "fresh.log");
      const scriptPath = path.join(root, "graceful-fresh-lane.mjs");
      const readyPath = path.join(root, "ready");
      const donePath = path.join(root, "done");
      const descendantScript = [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "process.on('SIGTERM', () => {",
        `  setTimeout(() => { writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      writeFileSync(
        scriptPath,
        [
          "import { spawn } from 'node:child_process';",
          `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
            descendantScript,
          )}], { stdio: "ignore" });`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const command = spawnLoggedCommand(process.execPath, [scriptPath], logPath, {}, undefined, {
        timeoutKillGraceMs: 500,
        timeoutLabel: "fresh lane grace test",
        timeoutMs: 500,
      });

      await waitFor(() => existsSync(readyPath), "fresh lane descendant readiness");
      await expect(command).resolves.toBe(124);
      expect(readFileSync(donePath, "utf8")).toBe("done");
    },
  );

  it("clears update stream timers when spawning the guest command fails", async () => {
    vi.useFakeTimers();
    const smoke = withEnv(
      { OPENAI_API_KEY: "test-key" },
      () =>
        new NpmUpdateSmoke({
          ...TEST_AUTH,
          dependencyTarballs: [],
          registryPackageTarballs: [],
          json: false,
          packageSpec: "openclaw@latest",
          platforms: new Set<Platform>(["linux"]),
          provider: "openai",
          updateTarget: "local-main",
        }),
    );
    const runStreamingToJobLog = Reflect.get(smoke, "runStreamingToJobLog") as (
      command: string,
      args: string[],
      timeoutMs: number,
      ctx: {
        append(chunk: string | Uint8Array): void;
        logPath: string;
        signal: AbortSignal;
      },
    ) => Promise<number>;

    await expect(
      runStreamingToJobLog.call(smoke, "openclaw-definitely-missing-command", [], 60 * 60 * 1000, {
        append: () => undefined,
        logPath: "",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "lets update stream descendants exit during timeout kill grace",
    async () => {
      const root = tempDirs.make("openclaw-parallels-npm-update-");
      const scriptPath = path.join(root, "stream-update-grace.mjs");
      const readyPath = path.join(root, "stream-ready");
      const donePath = path.join(root, "stream-done");
      const smoke = withEnv(
        { OPENAI_API_KEY: "test-key" },
        () =>
          new NpmUpdateSmoke({
            ...TEST_AUTH,
            dependencyTarballs: [],
            registryPackageTarballs: [],
            json: false,
            packageSpec: "openclaw@latest",
            platforms: new Set<Platform>(["linux"]),
            provider: "openai",
            updateTarget: "local-main",
          }),
      );
      const runStreamingToJobLog = Reflect.get(smoke, "runStreamingToJobLog") as (
        command: string,
        args: string[],
        timeoutMs: number,
        ctx: {
          append(chunk: string | Uint8Array): void;
          logPath: string;
          signal: AbortSignal;
        },
      ) => Promise<number>;
      const descendantScript = [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "process.on('SIGTERM', () => {",
        `  setTimeout(() => { writeFileSync(${JSON.stringify(donePath)}, 'done'); process.exit(0); }, 75);`,
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      writeFileSync(
        scriptPath,
        [
          "import { spawn } from 'node:child_process';",
          `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(
            descendantScript,
          )}], { stdio: "ignore" });`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const command = runStreamingToJobLog.call(smoke, process.execPath, [scriptPath], 500, {
        append: () => undefined,
        logPath: path.join(root, "update.log"),
        signal: new AbortController().signal,
      });

      await waitFor(() => existsSync(readyPath), "update stream descendant readiness");
      await expect(command).resolves.toBe(124);
      expect(readFileSync(donePath, "utf8")).toBe("done");
    },
  );

  it("runs Windows updates through a detached done-file runner", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const transports = readFileSync(GUEST_TRANSPORTS_PATH, "utf8");

    expect(script).toContain("runWindowsBackgroundPowerShell");
    expect(transports).toContain("runWindowsBackgroundPowerShell");
    expect(transports).toContain("__OPENCLAW_BACKGROUND_EXIT__");
    expect(transports).toContain("__OPENCLAW_BACKGROUND_DONE__");
    expect(transports).toContain("${options.label} timed out");
  });

  it("cleans timed-out Windows background work", async () => {
    const decodedCommands: string[] = [];
    const inputs: string[] = [];
    const fakeRun: typeof hostCommandRun = (_command, args, options) => {
      const decoded = decodePowerShellFromArgs(args);
      decodedCommands.push(decoded);
      if (options?.input) {
        inputs.push(options.input);
      }
      if (decoded.includes('cmd.exe /d /s /c start "" /b powershell.exe')) {
        return { status: 0, stderr: "", stdout: "started\n" };
      }
      if (args.includes("cmd.exe")) {
        return { status: 0, stderr: "", stdout: "wait\n" };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    await expect(
      runWindowsBackgroundPowerShell({
        label: "windows background timeout",
        pollIntervalMs: 1,
        runCommand: fakeRun,
        script: "Start-Sleep -Seconds 60",
        timeoutMs: 5,
        vmName: "Windows Test",
      }),
    ).rejects.toThrow("windows background timeout timed out");

    const commands = decodedCommands.join("\n---\n");
    const payloads = inputs.join("\n---\n");
    expect(commands).toContain("$pidPath");
    expect(commands).toContain("function Write-OpenClawUtf8File");
    expect(commands).toContain("[System.Text.UTF8Encoding]::new($false)");
    expect(payloads).toContain("Write-OpenClawUtf8File $exitPath '0'");
    expect(payloads).toContain("Write-OpenClawUtf8File $donePath 'done'");
    expect(payloads).toContain("Write-OpenClawUtf8File $pidPath ([string]$PID)");
    expect(commands).toContain('cmd.exe /d /s /c start "" /b powershell.exe');
    expect(commands).toContain("icacls.exe $runDir /inheritance:r");
    expect(commands).toContain("Stop-OpenClawBackgroundProcessTree ([int]$backgroundPid)");
    expect(commands).toContain(
      'Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId"',
    );
    expect(commands).toContain(
      "Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath, $pidPath",
    );
    expect(`${commands}\n${payloads}`).not.toContain("Set-Content -Path $exitPath");
    expect(`${commands}\n${payloads}`).not.toContain("Set-Content -Path $donePath");
    expect(commands).not.toContain("Set-Content -Path $pidPath");
    expect(commands).not.toContain("ReadAllBytes");
  });

  it.each([
    {
      scenario: "a successfully launched job",
      launchStatus: 0,
      launchOutput: "started\n",
      expectedError: "windows setup deadline timed out",
    },
    {
      scenario: "a launch that never materializes",
      launchStatus: 0,
      launchOutput: "",
      expectedError: "windows setup deadline background launch failed with exit code 0",
    },
    {
      scenario: "a genuine launch failure",
      launchStatus: 17,
      launchOutput: "",
      expectedError: "windows setup deadline background launch failed with exit code 17",
    },
  ])("preserves $scenario when Windows setup exhausts its active budget", async (testCase) => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let launchAttempts = 0;
    const fakeRun: typeof hostCommandRun = (_command, args, options) => {
      if (options?.input) {
        now += 2;
        return { status: 0, stderr: "", stdout: "" };
      }
      const decoded = decodePowerShellFromArgs(args);
      if (decoded.includes('cmd.exe /d /s /c start "" /b powershell.exe')) {
        launchAttempts++;
        return { status: testCase.launchStatus, stderr: "", stdout: testCase.launchOutput };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    try {
      await expect(
        runWindowsBackgroundPowerShell({
          label: "windows setup deadline",
          pollIntervalMs: 1,
          runCommand: fakeRun,
          script: "Write-Output test",
          timeoutMs: 5,
          vmName: "Windows Test",
        }),
      ).rejects.toThrow(testCase.expectedError);
      expect(launchAttempts).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("drains a completed Windows job when setup exhausts the active budget", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let completionProbes = 0;
    let logProbes = 0;
    const fakeRun: typeof hostCommandRun = (_command, args, options) => {
      if (options?.input) {
        now += 2;
        return { status: 0, stderr: "", stdout: "" };
      }
      const decoded = decodePowerShellFromArgs(args);
      if (decoded.includes('cmd.exe /d /s /c start "" /b powershell.exe')) {
        return { status: 0, stderr: "", stdout: "started\n" };
      }
      if (args.includes("cmd.exe")) {
        const command = args.at(-1) ?? "";
        if (command.includes("__OPENCLAW_BACKGROUND_DONE__")) {
          logProbes++;
          const markers = extractWindowsBackgroundControlMarkers(command);
          return {
            status: 0,
            stderr: "",
            stdout: [`${markers.exitPrefix}0`, markers.done, ""].join("\n"),
          };
        }
        if (command.includes("(echo done) else (echo wait)")) {
          completionProbes++;
          return { status: 0, stderr: "", stdout: "done\n" };
        }
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    try {
      await expect(
        runWindowsBackgroundPowerShell({
          label: "windows completed before first poll",
          pollIntervalMs: 1,
          runCommand: fakeRun,
          script: "Write-Output done",
          timeoutMs: 5,
          vmName: "Windows Test",
        }),
      ).resolves.toBeUndefined();
      expect(completionProbes).toBe(1);
      expect(logProbes).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not treat Windows background log text as completion control", async () => {
    const decodedCommands: string[] = [];
    const fakeRun: typeof hostCommandRun = (_command, args) => {
      const decoded = decodePowerShellFromArgs(args);
      decodedCommands.push(decoded);
      if (decoded.includes('cmd.exe /d /s /c start "" /b powershell.exe')) {
        return { status: 0, stderr: "", stdout: "started\n" };
      }
      if (args.includes("cmd.exe")) {
        return { status: 0, stderr: "", stdout: "done\n" };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    await expect(
      runWindowsBackgroundPowerShell({
        label: "windows background marker smuggle",
        pollIntervalMs: 1,
        runCommand: fakeRun,
        script: "Write-Output done",
        timeoutMs: 5,
        completedLogDrainGraceMs: 5,
        vmName: "Windows Test",
      }),
    ).rejects.toThrow("windows background marker smuggle timed out");

    expect(decodedCommands.join("\n")).toContain(
      "Stop-OpenClawBackgroundProcessTree ([int]$backgroundPid)",
    );
  });

  it("drains completed Windows background logs before cleanup", async () => {
    const decodedCommands: string[] = [];
    const output: string[] = [];
    let pollCount = 0;
    const fakeRun: typeof hostCommandRun = (_command, args) => {
      const decoded = decodePowerShellFromArgs(args);
      decodedCommands.push(decoded);
      if (decoded.includes('cmd.exe /d /s /c start "" /b powershell.exe')) {
        return { status: 0, stderr: "", stdout: "started\n" };
      }
      if (args.includes("cmd.exe")) {
        const command = args.at(-1) ?? "";
        if (command.includes("type")) {
          pollCount += 1;
          const markers = extractWindowsBackgroundControlMarkers(command);
          return {
            status: 0,
            stderr: "",
            stdout: ["first chunk", `${markers.exitPrefix}0`, markers.done, ""].join("\n"),
          };
        }
        if (command.includes("if exist")) {
          return { status: 0, stderr: "", stdout: "done\n" };
        }
        return { status: 0, stderr: "", stdout: "" };
      }
      return { status: 0, stderr: "", stdout: "" };
    };

    await expect(
      runWindowsBackgroundPowerShell({
        append: (chunk) => output.push(String(chunk)),
        completedLogDrainGraceMs: 1000,
        label: "windows background drain",
        pollIntervalMs: 5000,
        runCommand: fakeRun,
        script: "Write-Output done",
        timeoutMs: 20,
        vmName: "Windows Test",
      }),
    ).resolves.toBeUndefined();

    expect(pollCount).toBe(1);
    expect(output.join("")).toContain("first chunk");
    expect(decodedCommands.join("\n")).not.toContain("Stop-OpenClawBackgroundProcessTree");
    expect(decodedCommands.join("\n")).toContain(
      "Remove-Item -Path $scriptPath, $logPath, $donePath, $exitPath, $pidPath",
    );
  });

  it("keeps macOS sudo fallback update scripts readable by the desktop user", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('"/usr/sbin/chown"');
    expect(script).toContain("macosUpdateExec.ownerUser");
    expect(script).toContain("ownerUser: fallbackUser");
  });

  it("selects macOS desktop users with homes on spaced mounted volumes", () => {
    const root = tempDirs.make("openclaw-parallels-npm-update-");
    const prlctlPath = path.join(root, "prlctl");
    writeFileSync(
      prlctlPath,
      `#!/usr/bin/env bash
set -euo pipefail
args=" $* "
if [[ "$args" == *" /usr/bin/stat -f %Su /dev/console"* ]]; then
  printf '%s\\n' 'loginwindow'
  exit 0
fi
if [[ "$args" == *" /usr/bin/dscl . -list /Users NFSHomeDirectory"* ]]; then
  printf '%s\\n' '_daemon /var/root'
  printf '%s\\n' 'clawuser /Volumes/Macintosh HD/Users/clawuser'
  exit 0
fi
exit 7
`,
    );
    chmodSync(prlctlPath, 0o755);

    withEnv(
      {
        OPENAI_API_KEY: "test-key",
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      () => {
        const smoke = new NpmUpdateSmoke({
          ...TEST_AUTH,
          dependencyTarballs: [],
          registryPackageTarballs: [],
          json: false,
          packageSpec: "openclaw@latest",
          platforms: new Set<Platform>(["macos"]),
          provider: "openai",
          updateTarget: "local-main",
        });
        const resolveMacosDesktopUser = Reflect.get(
          smoke,
          "resolveMacosDesktopUser",
        ) as () => string;

        expect(resolveMacosDesktopUser.call(smoke)).toBe("clawuser");
      },
    );
  });

  it("keeps spaces in macOS sudo fallback desktop homes", () => {
    const root = tempDirs.make("openclaw-parallels-npm-update-");
    const prlctlPath = path.join(root, "prlctl");
    writeFileSync(
      prlctlPath,
      `#!/usr/bin/env bash
set -euo pipefail
args=" $* "
if [[ "$args" == *" /usr/bin/dscl . -read /Users/clawuser NFSHomeDirectory"* ]]; then
  printf '%s\\n' 'NFSHomeDirectory: /Volumes/Macintosh HD/Users/clawuser'
  exit 0
fi
exit 7
`,
    );
    chmodSync(prlctlPath, 0o755);

    withEnv(
      {
        OPENAI_API_KEY: "test-key",
        PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      () => {
        const smoke = new NpmUpdateSmoke({
          ...TEST_AUTH,
          dependencyTarballs: [],
          registryPackageTarballs: [],
          json: false,
          packageSpec: "openclaw@latest",
          platforms: new Set<Platform>(["macos"]),
          provider: "openai",
          updateTarget: "local-main",
        });
        const resolveMacosDesktopHome = Reflect.get(smoke, "resolveMacosDesktopHome") as (
          user: string,
        ) => string;

        expect(resolveMacosDesktopHome.call(smoke, "clawuser")).toBe(
          "/Volumes/Macintosh HD/Users/clawuser",
        );
      },
    );
  });

  it("writes macOS update scripts through the desktop user transport", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("const macosUpdateExec = this.resolveMacosUpdateExec(ctx)");
    expect(script).toContain('{ execArgs: macosUpdateExec.execArgs, mode: "700" }');
    expect(script).toContain('["exec", vm, ...execArgs, "/usr/bin/tee", scriptPath]');
    expect(script).toContain('["exec", vm, ...execArgs, "/bin/chmod", mode, scriptPath]');
    expect(script).toContain("ownerUser: user");
  });

  it("scrubs future plugin entries before invoking old same-guest updaters", () => {
    const script = readFileSync(UPDATE_SCRIPTS_PATH, "utf8");
    const windowsScript = windowsUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.5.3-beta.2",
      updateTarget: "2026.5.3-beta.2",
    });
    const macosScript = macosUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.5.3-beta.2",
      updateTarget: "2026.5.3-beta.2",
    });

    expect(script).toContain("Remove-FuturePluginEntries");
    expect(script).toContain("scrub_future_plugin_entries");
    expect(script).toContain("delete plugins.entries.feishu");
    expect(script).toContain("delete plugins.entries.whatsapp");
    expect(windowsScript).toContain(
      'const futurePluginIds = new Set(["feishu", "whatsapp", "openai"])',
    );
    expect(windowsScript).toContain('replace(/^\\uFEFF/u, "")');
    expect(windowsScript).toContain("if (allow.length !== plugins.allow.length)");
    expect(windowsScript).toContain('JSON.stringify(config, null, 2) + "\\n"');
    expect(windowsScript).not.toContain("ConvertTo-Json -Depth 100");
    expect(windowsScript).toContain("& node.exe $nodeScriptPath $configPath");
    expect(windowsScript).toContain(
      "Remove-Item $nodeScriptPath -Force -ErrorAction SilentlyContinue",
    );
    expect(windowsScript).toContain("Remove-FuturePluginEntries\nStop-OpenClawGatewayProcesses");
    expect(script).toContain("scrub_future_plugin_entries\nstop_openclaw_gateway_processes");
    expect(macosScript).toContain('OPENCLAW_BIN="$(resolve_required_command openclaw)"');
    expect(macosScript).toContain("/usr/local/bin:/usr/local/sbin");
    expect(macosScript).not.toContain("/opt/homebrew/bin/openclaw");
  });

  it("preserves bundled plugin inventory during updates while isolating POSIX gateway stops", () => {
    const input = {
      auth: TEST_AUTH,
      expectedNeedle: "2026.5.3-beta.2",
      updateTarget: "2026.5.3-beta.2",
    };
    const windowsScript = windowsUpdateScript(input);
    const macosScript = macosUpdateScript(input);
    const linuxScript = linuxUpdateScript(input);
    const updateLines = [windowsScript, macosScript, linuxScript].map((generatedScript) =>
      generatedScript.split("\n").find((line) => line.includes(" update --tag ")),
    );

    expect(updateLines).not.toContain(undefined);
    for (const updateLine of updateLines) {
      expect(updateLine).not.toContain("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
    }
    expect(windowsScript).toContain(
      "Invoke-WithScopedEnv @{ OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS = '1'",
    );
    expect(macosScript).toContain(
      'OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 "$OPENCLAW_BIN" gateway stop',
    );
    expect(linuxScript).toContain(
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 OPENCLAW_ALLOW_ROOT=1 openclaw gateway stop",
    );
  });

  it("limits the Windows update environment to the update invocation", () => {
    const script = windowsUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.5.3-beta.2",
      updateTarget: "2026.5.3-beta.2",
    });

    const updateIndex = script.indexOf("Invoke-OpenClaw update --tag");
    const scopedIndex = script.indexOf(
      "Invoke-WithScopedEnv @{ OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
    );
    const versionIndex = script.indexOf("Invoke-OpenClaw --version", scopedIndex);
    const startIndex = script.indexOf("\nStart-OpenClawGateway\n", updateIndex);
    const agentIndex = script.indexOf("Invoke-OpenClaw agent --local");

    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(scopedIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(scopedIndex);
    expect(versionIndex).toBeGreaterThan(updateIndex);
    expect(startIndex).toBeGreaterThan(updateIndex);
    expect(agentIndex).toBeGreaterThan(updateIndex);
    expect(script).not.toContain("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
  });

  it("generates a .NET-safe Windows stale import regex in the update-failure guard", () => {
    const script = windowsUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.4.30",
      updateTarget: "latest",
    });
    const staleImportLine = script.match(/\$stalePostSwapImport = [^\n]+/)?.[0];
    const staleImportMatch = script.match(/\$updateText -match '(node_modules[^']+)'/);
    const staleImportPattern = staleImportMatch?.[1];

    if (!staleImportLine) {
      throw new Error("missing generated Windows stale import guard");
    }
    if (!staleImportPattern) {
      throw new Error("missing generated Windows stale import regex");
    }
    expect(staleImportLine).toContain("$updateText -match 'ERR_MODULE_NOT_FOUND'");
    expect(staleImportLine).toContain(`$updateText -match '${staleImportPattern}'`);
    expect(staleImportPattern).toBe(
      String.raw`node_modules\\openclaw\\dist\\[^\\]+-[A-Za-z0-9_-]+\.js`,
    );
    expect(staleImportPattern).not.toContain("node_modules\\openclaw\\dist\\");
    expect(staleImportPattern.match(/\\\\/g)).toHaveLength(4);
    const representativeUpdateFailure = String.raw`Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\runner\AppData\Roaming\npm\node_modules\openclaw\dist\main-a1_B2.js' imported from C:\Users\runner\AppData\Roaming\npm\node_modules\openclaw\dist\cli.js`;
    const generatedRegex = new RegExp(staleImportPattern);
    expect(generatedRegex.test(representativeUpdateFailure)).toBe(true);
    expect(generatedRegex.test(String.raw`node_modules\openclaw\dist\main.js`)).toBe(false);
  });
});
