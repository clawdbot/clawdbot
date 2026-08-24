import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type WorkerProfile,
  type WorkerProvider,
  WorkerProviderError,
} from "openclaw/plugin-sdk/plugin-entry";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as doctorRuntime from "./crabbox-worker-doctor-runtime.js";
import {
  findCrabboxBinary,
  operationLeaseId,
  resolveCrabboxBinary,
} from "./crabbox-worker-profile.js";
import { createCrabboxWorkerProvider, resolveOpenClawRoot } from "./crabbox-worker-provider.js";
import {
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_MACHINE_CATALOG_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";

const OPERATION_ID = `provision:v2:${"0".repeat(64)}`;
const LEASE_ID = "cbx_6071fc2062a6";
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
const SIBLING_BINARY = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");
const WORKER_WALLPAPER_PATH = fileURLToPath(
  new URL("../assets/openclaw-worker-wallpaper.png", import.meta.url),
);
const INSPECT_FAILURE_PREFIX = "Crabbox inspect failed with exit code 2: ";
const PROFILE = {
  provider: "aws",
  class: "standard",
  ttl: "24h",
  idleTimeout: "60m",
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type CrabboxWorkerProviderDependencies = NonNullable<
  Parameters<typeof createCrabboxWorkerProvider>[0]
>;
type CrabboxCommandRunner = NonNullable<CrabboxWorkerProviderDependencies["runCommand"]>;

function commandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: LEASE_ID,
    providerMetadata: { instanceProfileAttached: false },
    state: "running",
    host: "fallback.example.test",
    sshHost: "worker.example.test",
    sshPort: "2222",
    sshUser: "openclaw",
    sshKey: "/tmp/crabbox-worker-key",
    ready: true,
    ...overrides,
  });
}

function lifecycleLease(leaseId = LEASE_ID, profile: WorkerProfile = PROFILE) {
  return { leaseId, profile };
}

function providerWithRawRunner(
  runCommand: CrabboxCommandRunner,
  warn?: (message: string) => void,
): WorkerProvider {
  const provider = createCrabboxWorkerProvider({
    runCommand,
    openclawRoot: OPENCLAW_ROOT,
    pathEnv: "",
    isExecutable: (candidate) => candidate === SIBLING_BINARY,
    sleep: async () => {},
    wallpaperPath: WORKER_WALLPAPER_PATH,
    ...(warn ? { warn } : {}),
  });
  return {
    ...provider,
    provision: (profile, operationId, options) =>
      provider.provision(profile, operationId, {
        ...options,
        beginNodeEnrollment:
          options?.beginNodeEnrollment ??
          (async () => ({
            mode: "connect" as const,
            setupCode: "secret-setup-value",
            setupId: "setup-id",
            openclawVersion: "2026.8.1",
            packageSpecs: ["openclaw@2026.8.1"],
            displayName: "Cloud worker test",
            waitForDeviceId: async () => "device-1",
          })),
      }),
  };
}

function providerWithRunner(runCommand: CrabboxCommandRunner, warn?: (message: string) => void) {
  return providerWithRawRunner(async (argv, options) => {
    if (argv[1] === "config" && argv[2] === "show") {
      return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
    }
    return runCommand(argv, options);
  }, warn);
}

function failedNodeEnrollment(
  error: Error,
): NonNullable<Parameters<WorkerProvider["provision"]>[2]> {
  return {
    beginNodeEnrollment: async () => ({
      mode: "connect",
      setupCode: "secret-setup-value",
      setupId: "setup-id",
      openclawVersion: "2026.8.1",
      packageSpecs: ["openclaw@2026.8.1"],
      displayName: "Cloud worker test",
      waitForDeviceId: async () => {
        throw error;
      },
    }),
  };
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("Crabbox worker provider", () => {
  it("derives ordered machine classes and shapes while preserving configured defaults", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult({
        stdout: JSON.stringify([
          {
            provider: "aws",
            classes: [
              { class: "tiny", type: "c7a.2xlarge", vcpu: 8, memoryGb: 16 },
              { class: "small", type: "c7a.4xlarge", vcpu: 16, memoryGb: 32 },
              { class: "standard", type: "c7a.8xlarge", vcpu: 32, memoryGb: 64 },
              { class: "fast", type: "c7a.16xlarge", vcpu: 64, memoryGb: 128 },
              { class: "large", type: "c7a.24xlarge", vcpu: 96, memoryGb: 192 },
              { class: "beast", type: "c7a.48xlarge", vcpu: 192, memoryGb: 384 },
            ],
          },
        ]),
      });
    });
    expect(provider.supportedExecutionModes).toEqual(["worker-turn"]);
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([
      { id: "tiny", label: "Tiny", cpu: 8, memoryGb: 16 },
      { id: "small", label: "Small", cpu: 16, memoryGb: 32 },
      {
        id: "standard",
        label: "Standard",
        cpu: 32,
        memoryGb: 64,
        default: true,
      },
      { id: "fast", label: "Fast", cpu: 64, memoryGb: 128 },
      { id: "large", label: "Large", cpu: 96, memoryGb: 192 },
      { id: "beast", label: "Beast", cpu: 192, memoryGb: 384 },
    ]);
    expect(await provider.listMachineOptions?.({ ...PROFILE, class: "c7a.24xlarge" })).toEqual([
      { id: "tiny", label: "Tiny", cpu: 8, memoryGb: 16 },
      { id: "small", label: "Small", cpu: 16, memoryGb: 32 },
      { id: "standard", label: "Standard", cpu: 32, memoryGb: 64 },
      { id: "fast", label: "Fast", cpu: 64, memoryGb: 128 },
      { id: "large", label: "Large", cpu: 96, memoryGb: 192 },
      { id: "beast", label: "Beast", cpu: 192, memoryGb: 384 },
      {
        id: "c7a.24xlarge",
        label: "c7a.24xlarge",
        default: true,
      },
    ]);
    await provider.listMachineOptions?.(PROFILE);
    expect(calls.filter((argv) => argv[1] === "providers")).toHaveLength(1);
  });

  it("bounds and filters malformed catalogs before gateway normalization", async () => {
    const invalidClass = "x".repeat(129);
    const classes = [
      { class: invalidClass, vcpu: 1, memoryGb: 2 },
      ...Array.from({ length: 40 }, (_, index) => ({
        class: `class-${String(index).padStart(2, "0")}`,
        vcpu: index === 0 ? 0 : index + 1,
        memoryGb: index === 0 ? 1.5 : (index + 1) * 2,
      })),
    ];
    const provider = providerWithRunner(async () =>
      commandResult({ stdout: JSON.stringify([{ provider: "aws", classes }]) }),
    );

    const options = await provider.listMachineOptions?.({ ...PROFILE, class: "class-00" });

    expect(options).toHaveLength(32);
    expect(options?.[0]).toEqual({ id: "class-00", label: "Class-00", default: true });
    expect(options?.at(-1)).toEqual({
      id: "class-31",
      label: "Class-31",
      cpu: 32,
      memoryGb: 64,
    });
    expect(options?.some((option) => option.id === invalidClass)).toBe(false);
  });

  it("keeps machine-shape catalogs separate per resolved binary", async () => {
    const calls: { binary: string; argv: string[] }[] = [];
    const provider = providerWithRunner(async (argv) => {
      const binary = String(argv[0]);
      calls.push({ binary, argv });
      const vcpu = binary.endsWith("other-crabbox") ? 8 : 32;
      return commandResult({
        stdout: JSON.stringify([
          {
            provider: "aws",
            classes: [{ class: "standard", type: "t", vcpu, memoryGb: vcpu * 2 }],
          },
        ]),
      });
    });

    const first = await provider.listMachineOptions?.({ ...PROFILE, binary: "/opt/crabbox" });
    const second = await provider.listMachineOptions?.({
      ...PROFILE,
      binary: "/opt/other-crabbox",
    });

    // A shared slot would hand the second profile the first binary's sizes.
    expect(first?.[0]).toMatchObject({ id: "standard", cpu: 32, memoryGb: 64 });
    expect(second?.[0]).toMatchObject({ id: "standard", cpu: 8, memoryGb: 16 });
    expect(calls.filter((call) => call.argv[1] === "providers")).toHaveLength(2);
  });

  it("bounds the catalog read well below the lifecycle timeout", async () => {
    let requestedTimeoutMs: number | undefined;
    const provider = providerWithRunner(async (argv, options) => {
      if (argv[1] === "providers") {
        requestedTimeoutMs = (options as { timeoutMs?: number } | undefined)?.timeoutMs;
        return commandResult({ code: null, killed: true, termination: "timeout" });
      }
      return commandResult({ stdout: "[]" });
    });

    // A hung binary must degrade to label-only choices instead of holding the
    // picker response for the full lifecycle budget.
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([
      { id: "standard", label: "Standard", default: true },
      { id: "fast", label: "Fast" },
      { id: "large", label: "Large" },
      { id: "beast", label: "Beast" },
    ]);
    expect(requestedTimeoutMs).toBe(CRABBOX_MACHINE_CATALOG_TIMEOUT_MS);
    expect(requestedTimeoutMs).toBeLessThan(CRABBOX_LIFECYCLE_TIMEOUT_MS);
  });

  it.each([
    {
      name: "cannot start",
      result: () => Promise.reject(new Error("missing binary")),
      warns: true,
    },
    {
      name: "exits non-zero",
      result: () => Promise.resolve(commandResult({ code: 2 })),
      warns: true,
    },
    {
      name: "times out",
      result: () =>
        Promise.resolve(commandResult({ code: null, killed: true, termination: "timeout" })),
      warns: true,
    },
    {
      name: "returns junk JSON",
      result: () => Promise.resolve(commandResult({ stdout: "not-json" })),
      warns: true,
    },
    {
      name: "returns an empty catalog",
      result: () => Promise.resolve(commandResult({ stdout: "[]" })),
      warns: false,
    },
    {
      name: "omits classes",
      result: () =>
        Promise.resolve(commandResult({ stdout: JSON.stringify([{ provider: "aws" }]) })),
      warns: false,
    },
    {
      name: "reports another provider",
      result: () =>
        Promise.resolve(
          commandResult({
            stdout: JSON.stringify([
              {
                provider: "gcp",
                classes: [{ class: "standard", vcpu: 32, memoryGb: 64 }],
              },
            ]),
          }),
        ),
      warns: false,
    },
  ])("keeps complete label-only options when providers $name", async ({ result, warns }) => {
    const warn = vi.fn();
    const provider = providerWithRunner(result, warn);

    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([
      { id: "standard", label: "Standard", default: true },
      { id: "fast", label: "Fast" },
      { id: "large", label: "Large" },
      { id: "beast", label: "Beast" },
    ]);
    await provider.listMachineOptions?.(PROFILE);
    expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0);
  });

  it.each([
    {
      name: "non-PNG bytes",
      bytes: Buffer.from("not a PNG"),
      message: "Crabbox worker wallpaper is not a PNG",
    },
    {
      name: "wrong PNG dimensions",
      bytes: (() => {
        const bytes = fs.readFileSync(WORKER_WALLPAPER_PATH);
        bytes.writeUInt32BE(1023, 16);
        return bytes;
      })(),
      message: "Crabbox worker wallpaper must be 1024x576; got 1023x576",
    },
  ])("rejects $name during provider registration", ({ bytes, message }) => {
    const tempDir = tempDirs.make("openclaw-crabbox-wallpaper-");
    const wallpaperPath = path.join(tempDir, "wallpaper.png");
    fs.writeFileSync(wallpaperPath, bytes);
    expect(() => createCrabboxWorkerProvider({ wallpaperPath })).toThrow(message);
  });

  it("returns the environment-bound node after enrollment", async () => {
    let warmed = false;
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv.includes(LEASE_ID)) {
        return commandResult({
          stdout: inspectJson({ sshFallbackPorts: [22], sshHostKey: HOST_KEY }),
        });
      }
      return warmed
        ? commandResult({
            stdout: inspectJson({ sshFallbackPorts: [22], sshHostKey: HOST_KEY }),
          })
        : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).resolves.toEqual({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
      sharedHost: false,
    });
  });

  it("resumes a bound node without replaying the consumed setup code", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      return argv[1] === "inspect"
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult();
    });

    await expect(
      provider.provision({ ...PROFILE, desktop: true }, OPERATION_ID, {
        beginNodeEnrollment: async () => ({
          mode: "resume",
          deviceId: "device-bound",
          openclawVersion: "2026.8.1",
          packageSpecs: ["openclaw@2026.8.1"],
          displayName: "Bound worker",
          waitForDeviceId: async () => "device-bound",
        }),
      }),
    ).resolves.toMatchObject({
      node: { deviceId: "device-bound" },
      desktop: {
        protocol: "rfb",
        port: 5900,
        apps: [{ id: "browser" }, { id: "terminal" }],
      },
    });
    const desktopSetup = calls.find(
      (call) =>
        call.argv[1] === "run" && String(call.options.input).includes("openclaw-worker-browser"),
    )?.options.input;
    const desktopSetupText = String(desktopSetup);
    expect(desktopSetupText).toContain("worker_user=$(id -un)");
    expect(desktopSetupText).toContain('worker_home=$(getent passwd "$worker_uid"');
    expect(desktopSetupText).toContain(`worker-browser/${LEASE_ID}`);
    const desktopSetupLines = desktopSetupText.split("\n");
    for (const expectedLine of [
      '[ -r /var/lib/crabbox/desktop.env ] || { echo "Crabbox desktop environment is unavailable" >&2; exit 1; }',
      "grep -Fx 'CRABBOX_DESKTOP_ENV=xfce' /var/lib/crabbox/desktop.env >/dev/null || { echo \"Crabbox desktop environment is not XFCE\" >&2; exit 1; }",
      "grep -Fx 'DISPLAY=:99' /var/lib/crabbox/desktop.env >/dev/null || { echo \"Crabbox XFCE display is not :99\" >&2; exit 1; }",
      "export DISPLAY=:99",
    ]) {
      expect(desktopSetupLines.filter((line) => line === expectedLine)).toHaveLength(3);
    }
    expect(desktopSetupText).not.toContain(". /var/lib/crabbox/desktop.env");
    expect(desktopSetupText).not.toContain("/var/lib/crabbox/browser.env");
    expect(desktopSetupLines).not.toContain("export DISPLAY");
    expect(desktopSetupText).toContain(
      'mapfile -t session_pids < <(pgrep -u "$worker_uid" -x xfce4-session || true)',
    );
    expect(desktopSetupText).toContain("Expected exactly one worker-owned XFCE session");
    expect(desktopSetupText).toContain('session_pid="${session_pids[0]}"');
    expect(desktopSetupText).toContain('read_xfce_process_environment "$session_pid"');
    expect(desktopSetupText).toContain(
      'mapfile -t renderer_pids < <(pgrep -u "$worker_uid" -x xfdesktop || true)',
    );
    expect(desktopSetupText).toContain('renderer_pid="${renderer_pids[0]}"');
    expect(desktopSetupText).toContain('read_xfce_process_environment "$renderer_pid"');
    expect(desktopSetupText).toContain('exec 8<"/proc/$process_pid/environ"');
    for (const [name, target] of [
      ["DISPLAY", "process_display"],
      ["DBUS_SESSION_BUS_ADDRESS", "process_dbus"],
      ["XDG_RUNTIME_DIR", "process_runtime_dir"],
    ]) {
      expect(desktopSetupText).toContain(`${name}=*) ${target}="\${process_variable#*=}"`);
    }
    expect(desktopSetupText).toContain('[ "$process_display" = ":99" ]');
    expect(desktopSetupText).toContain('DBUS_SESSION_BUS_ADDRESS="$process_dbus"');
    expect(desktopSetupLines).toContain("unset XDG_RUNTIME_DIR");
    expect(desktopSetupText).toContain('XDG_RUNTIME_DIR="$process_runtime_dir"');
    expect(desktopSetupText).toContain('[ -n "$DBUS_SESSION_BUS_ADDRESS" ]');
    expect(desktopSetupText).not.toContain("SESSION_MANAGER");
    expect(desktopSetupText).toContain(
      '[ "$process_display" = "$DISPLAY" ] && [ "$process_dbus" = "$DBUS_SESSION_BUS_ADDRESS" ]',
    );
    expect(desktopSetupText).toContain(
      'case "$XDG_RUNTIME_DIR" in ""|/*) ;; *) echo "XFCE session has an invalid XDG_RUNTIME_DIR"',
    );
    expect(desktopSetupText).toContain("export DBUS_SESSION_BUS_ADDRESS");
    expect(desktopSetupText).toContain('[ -z "$XDG_RUNTIME_DIR" ] || export XDG_RUNTIME_DIR');
    for (const signal of ["TERM", "KILL"]) {
      expect(desktopSetupText).toContain(`pkill -${signal} -u "$worker_uid" -x xfdesktop || true`);
    }
    expect(desktopSetupText).toContain('pgrep -u "$worker_uid" -x xfdesktop >/dev/null || break');
    expect(desktopSetupText).toContain(
      'nohup xfdesktop >"$worker_home/.cache/openclaw/xfdesktop.log" 2>&1 </dev/null &',
    );
    expect(desktopSetupText).toMatch(
      /for _attempt in \$\(seq 1 \d+\); do bind_xfdesktop_renderer && break; sleep 0\.1; done/u,
    );
    expect(desktopSetupText).toContain(
      "XFCE desktop renderer did not converge on the worker session",
    );
    expect(desktopSetupText).not.toMatch(/(?:^|\n)\s*(?:\.|source)\s+[^\n]*\/proc\//u);
    expect(desktopSetupText).not.toMatch(/(?:^|\n)\s*eval(?:\s|$)/u);
    expect(desktopSetupText).not.toMatch(/(?:^|\n)\s*(?:\.|source)\s+[^\n]*\.env/u);
    expect(desktopSetupText).toContain(
      "nohup /usr/local/bin/crabbox-browser --remote-debugging-address=127.0.0.1",
    );
    expect(desktopSetupText).toMatch(/for required_command in [^\n;]*python3[^\n;]*; do/u);
    expect(desktopSetupText).toContain(
      "base64.b64decode(sys.stdin.buffer.read().strip(),validate=True)",
    );
    const wallpaperPayload =
      /<<'WORKER_WALLPAPER_B64_EOF'\n(?<payload>[A-Za-z0-9+/=]+)\nWORKER_WALLPAPER_B64_EOF/u.exec(
        desktopSetupText,
      )?.groups?.payload;
    expect(wallpaperPayload).toBeDefined();
    expect(
      Buffer.from(wallpaperPayload ?? "", "base64").equals(fs.readFileSync(WORKER_WALLPAPER_PATH)),
    ).toBe(true);
    expect(desktopSetupText).toContain("xrandr --listmonitors");
    expect(desktopSetupText).toContain('printf "/backdrop/screen0/monitor%s/workspace%s');
    expect(desktopSetupText).toContain(
      'wallpaper_path="$worker_home/.local/share/backgrounds/openclaw-worker.png"',
    );
    expect(desktopSetupText).toContain('for backdrop in "${backdrop_roots[@]}"; do');
    const sessionExportIndex = desktopSetupText.indexOf("export DBUS_SESSION_BUS_ADDRESS");
    const sessionExtractionIndex = desktopSetupText.indexOf(
      'read_xfce_process_environment "$session_pid"',
    );
    const terminateRendererIndex = desktopSetupText.indexOf(
      'pkill -TERM -u "$worker_uid" -x xfdesktop',
    );
    const killRendererIndex = desktopSetupText.indexOf('pkill -KILL -u "$worker_uid" -x xfdesktop');
    const launchRendererIndex = desktopSetupText.indexOf("nohup xfdesktop");
    const convergeRendererIndex = desktopSetupText.indexOf(
      'bind_xfdesktop_renderer || { echo "XFCE desktop renderer did not converge',
    );
    const firstXfconfIndex = desktopSetupText.indexOf("xfconf-query -c xfce4-desktop");
    const xrandrIndex = desktopSetupText.indexOf("xrandr --listmonitors");
    const lastImageIndex = desktopSetupText.indexOf('-p "$backdrop/last-image"');
    const saveRendererIndex = desktopSetupText.indexOf(
      'renderer_pid_before_reload="$renderer_pid"',
    );
    const reloadRendererIndex = desktopSetupText.indexOf("xfdesktop --reload");
    const verifyRendererIndex = desktopSetupText.indexOf(
      '[ "$renderer_pid" = "$renderer_pid_before_reload" ]',
    );
    expect(sessionExtractionIndex).toBeGreaterThan(-1);
    expect(sessionExportIndex).toBeGreaterThan(sessionExtractionIndex);
    expect(terminateRendererIndex).toBeGreaterThan(sessionExportIndex);
    expect(killRendererIndex).toBeGreaterThan(terminateRendererIndex);
    expect(launchRendererIndex).toBeGreaterThan(killRendererIndex);
    expect(convergeRendererIndex).toBeGreaterThan(launchRendererIndex);
    expect(firstXfconfIndex).toBeGreaterThan(convergeRendererIndex);
    expect(xrandrIndex).toBeGreaterThan(sessionExportIndex);
    expect(lastImageIndex).toBeGreaterThan(-1);
    expect(saveRendererIndex).toBeGreaterThan(lastImageIndex);
    expect(reloadRendererIndex).toBeGreaterThan(saveRendererIndex);
    expect(verifyRendererIndex).toBeGreaterThan(reloadRendererIndex);
    expect(desktopSetupText.slice(reloadRendererIndex, verifyRendererIndex)).toContain(
      "bind_xfdesktop_renderer",
    );
    expect(desktopSetupText).not.toMatch(/pkill -(?:TERM|KILL) -x xfdesktop/u);
    const setup = calls.find(
      (call) => call.argv[1] === "run" && String(call.options.input).includes("node run"),
    )?.options.input;
    expect(String(setup)).toContain("node run --ephemeral --display-name 'Bound worker'");
    expect(String(setup)).not.toContain("config set nodeHost.workerRuns.enabled");
    expect(String(setup)).not.toContain("setup-code");
    expect(calls.flatMap((call) => call.argv)).not.toContain("ssh");
    expect(calls.flatMap((call) => call.argv)).not.toContain("scp");
    expect(calls.flatMap((call) => call.argv)).not.toContain("rsync");
  });

  it("runs the profile setup command on the ready lease and keeps it", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    let warmed = false;
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      return warmed || argv.includes(LEASE_ID)
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
    });

    const setup = "command -v node || install-node";
    await expect(provider.provision({ ...PROFILE, setup }, OPERATION_ID)).resolves.toMatchObject({
      leaseId: LEASE_ID,
    });
    const runCall = calls.find((call) => call.argv[1] === "run");
    expect(runCall?.argv.slice(1)).toEqual([
      "run",
      "--provider",
      "aws",
      "--network",
      "public",
      "--tailscale=false",
      "--id",
      LEASE_ID,
      "--keep=true",
      "--no-sync",
      "--script-stdin",
    ]);
    expect(runCall?.options.input).toBe(setup);
  });

  it("waits for post-setup SSH readiness and returns the final endpoint", async () => {
    const calls: string[][] = [];
    let leaseInspections = 0;
    let resolveFinalInspect!: (result: SpawnResult) => void;
    let markFinalInspectStarted!: () => void;
    const finalInspect = new Promise<SpawnResult>((resolve) => {
      resolveFinalInspect = resolve;
    });
    const finalInspectStarted = new Promise<void>((resolve) => {
      markFinalInspectStarted = resolve;
    });
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult();
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      leaseInspections += 1;
      if (leaseInspections === 1) {
        return commandResult({
          stdout: inspectJson({
            sshFallbackPorts: [22],
            sshHost: "before-setup.example.test",
            sshHostKey: HOST_KEY,
          }),
        });
      }
      if (leaseInspections === 2) {
        return commandResult({
          stdout: inspectJson({
            ready: false,
            sshFallbackPorts: [22],
            sshHost: "restarting.example.test",
            sshHostKey: HOST_KEY,
          }),
        });
      }
      markFinalInspectStarted();
      return await finalInspect;
    });

    const provision = provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID);
    let settled = false;
    void provision.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await finalInspectStarted;
    expect(settled).toBe(false);
    resolveFinalInspect(
      commandResult({
        stdout: inspectJson({
          sshFallbackPorts: [22, 2222],
          sshHost: "after-setup.example.test",
          sshHostKey: "ssh-ed25519 BBBB",
          sshPort: "2200",
        }),
      }),
    );

    await expect(provision).resolves.toMatchObject({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
      sharedHost: false,
    });
    expect(calls.map((argv) => argv[1])).toEqual([
      "warmup",
      "inspect",
      "run",
      "inspect",
      "inspect",
      "run",
      "inspect",
    ]);
  });

  it("leaves a lease live when it disappears from post-setup inspection", async () => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult();
      }
      if (argv[1] === "run" || argv[1] === "stop") {
        return commandResult();
      }
      inspections += 1;
      return inspections === 1
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
    ).rejects.toThrow("disappeared while waiting for SSH readiness");
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "run", "inspect"]);
  });

  it("re-attests security on the fresh post-setup inspect before polling", async () => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult();
      }
      if (argv[1] === "run" || argv[1] === "stop") {
        return commandResult();
      }
      inspections += 1;
      return commandResult({
        stdout: inspectJson({
          providerMetadata: { instanceProfileAttached: inspections > 1 },
          ready: inspections === 1,
          sshHostKey: HOST_KEY,
        }),
      });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "run", "inspect", "stop"]);
  });

  it("stops the lease when the profile setup command fails", async () => {
    const calls: string[][] = [];
    let warmed = false;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv[1] === "run") {
        return commandResult({ code: 7, stderr: "apt exploded" });
      }
      if (argv[1] === "stop") {
        return commandResult();
      }
      return warmed || argv.includes(LEASE_ID)
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("Crabbox setup failed with exit code 7"),
    });
    expect(calls.some((argv) => argv[1] === "stop" && argv.includes(LEASE_ID))).toBe(true);
  });

  it("preserves the allocated lease and both failures when setup cleanup times out", async () => {
    let releaseCommitted = false;
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run") {
        return commandResult({ code: 7, stderr: "node setup failed" });
      }
      if (argv[1] === "stop") {
        releaseCommitted = true;
        return commandResult({ code: null, killed: true, termination: "timeout" });
      }
      return commandResult();
    });

    const error = await provider
      .provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID)
      .catch((cause: unknown) => cause);

    expect(WorkerProviderError.isCleanupIndeterminate(error)).toBe(true);
    if (!WorkerProviderError.isCleanupIndeterminate(error)) {
      throw new Error("expected indeterminate worker cleanup error");
    }
    expect(error).toMatchObject({
      leaseId: LEASE_ID,
      provisionError: { message: expect.stringContaining("node setup failed") },
      cleanupError: { message: expect.stringContaining("stop did not exit normally (timeout)") },
    });
    expect(error.errors).toEqual([error.provisionError, error.cleanupError]);
    expect(releaseCommitted).toBe(true);
  });

  it("stops the lease when the profile setup command cannot start", async () => {
    const calls: string[][] = [];
    let warmed = false;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv[1] === "run") {
        throw new Error("spawn unavailable");
      }
      if (argv[1] === "stop") {
        return commandResult();
      }
      return warmed || argv.includes(LEASE_ID)
        ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
        : commandResult({ code: 4, stderr: `lease/server not found: ${argv.at(-2)}` });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
    ).rejects.toThrow("Crabbox setup could not start");
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("rejects an effective AWS instance profile after authoritative lease absence", async () => {
    const calls: string[][] = [];
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          return commandResult({
            code: 4,
            stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
          });
        }
        if (argv[1] === "stop") {
          throw new Error("authoritative absence must not run cleanup");
        }
        return commandResult({
          stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
        });
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
      wallpaperPath: WORKER_WALLPAPER_PATH,
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["config", "inspect"]);
  });

  it("applies AWS credential policy to case-insensitive provider input", async () => {
    const calls: string[][] = [];
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          return commandResult({
            code: 4,
            stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
          });
        }
        if (argv[1] === "stop") {
          throw new Error("authoritative absence must not run cleanup");
        }
        return commandResult({
          stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
        });
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
      wallpaperPath: WORKER_WALLPAPER_PATH,
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "AWS" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["config", "inspect"]);
  });

  it("cleans a committed fixed lease before making an AWS profile rejection permanent", async () => {
    const calls: string[][] = [];
    let creates = 0;
    let inspectTimeout = true;
    let profileRejected = false;
    let live = false;
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      if (argv[1] === "config") {
        return commandResult({
          stdout: JSON.stringify({
            aws: { instanceProfile: profileRejected ? "worker-role" : "" },
          }),
        });
      }
      if (argv[1] === "warmup") {
        if (!live) {
          creates += 1;
          live = true;
        }
        return commandResult();
      }
      if (argv[1] === "inspect") {
        if (inspectTimeout) {
          inspectTimeout = false;
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "stop") {
        live = false;
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    };

    await expect(
      providerWithRawRunner(runCommand).provision(PROFILE, OPERATION_ID),
    ).rejects.toThrow("inspect did not exit normally (timeout)");
    expect(live).toBe(true);
    profileRejected = true;

    await expect(
      providerWithRawRunner(runCommand).provision(PROFILE, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(creates).toBe(1);
    expect(live).toBe(false);
    expect(calls.map((argv) => argv[1])).toEqual([
      "config",
      "warmup",
      "inspect",
      "config",
      "inspect",
      "stop",
    ]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("cleans the exact fixed ID after malformed reconciliation inspection", async () => {
    const calls: string[][] = [];
    let live = true;
    const provider = providerWithRawRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "config") {
        return commandResult({
          stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
        });
      }
      if (argv[1] === "inspect") {
        return commandResult({ stdout: "{" });
      }
      if (argv[1] === "stop") {
        live = false;
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS instance profile must be empty for cloud workers",
    });
    expect(live).toBe(false);
    expect(calls.map((argv) => argv[1])).toEqual(["config", "inspect", "stop"]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it.each(["inspect", "stop"] as const)(
    "keeps AWS profile rejection transient while exact-ID %s is indeterminate",
    async (failurePoint) => {
      const calls: string[][] = [];
      let live = true;
      const provider = providerWithRawRunner(async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({
            stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
          });
        }
        if (argv[1] === "inspect") {
          return failurePoint === "inspect"
            ? commandResult({ code: null, killed: true, termination: "timeout" })
            : commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
        }
        if (argv[1] === "stop") {
          if (failurePoint === "stop") {
            return commandResult({ code: null, killed: true, termination: "timeout" });
          }
          live = false;
          return commandResult();
        }
        throw new Error(`unexpected Crabbox command: ${argv[1]}`);
      });

      const error = await provider
        .provision(PROFILE, OPERATION_ID)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toMatchObject({ code: "invalid_profile" });
      if (failurePoint === "stop") {
        expect(WorkerProviderError.isCleanupIndeterminate(error)).toBe(true);
        if (!WorkerProviderError.isCleanupIndeterminate(error)) {
          throw new Error("expected indeterminate worker cleanup error");
        }
        expect(error).toMatchObject({
          leaseId: LEASE_ID,
          provisionError: {
            message: "Crabbox AWS instance profile must be empty for cloud workers",
          },
          cleanupError: { message: expect.stringContaining("stop did not exit normally") },
        });
      } else {
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("cleanup is indeterminate during inspect");
        expect(message).toContain("Crabbox AWS instance profile must be empty for cloud workers");
        expect(message.length).toBeLessThanOrEqual(512);
      }
      expect(live).toBe(true);
      expect(calls.map((argv) => argv[1])).toEqual(
        failurePoint === "inspect" ? ["config", "inspect"] : ["config", "inspect", "stop"],
      );
    },
  );

  it("stops an AWS lease when provider metadata reports an instance profile", async () => {
    const calls: string[][] = [];
    let warmed = false;
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
        }
        if (argv[1] === "warmup") {
          warmed = true;
          return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
        }
        if (argv[1] === "inspect") {
          return warmed || argv.includes(LEASE_ID)
            ? commandResult({
                stdout: inspectJson({
                  providerMetadata: { instanceProfileAttached: true },
                  sshHostKey: HOST_KEY,
                }),
              })
            : commandResult({
                code: 4,
                stderr: `lease/server not found: ${argv[argv.indexOf("--id") + 1]}`,
              });
        }
        return commandResult();
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
      sleep: async () => {},
      wallpaperPath: WORKER_WALLPAPER_PATH,
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
    });
    expect(calls.some((argv) => argv[1] === "stop" && argv.includes(LEASE_ID))).toBe(true);
  });

  it.each([
    {
      state: "pending-metadata then ready-safe",
      inspections: [
        { providerMetadata: undefined, ready: false },
        {
          providerMetadata: { instanceProfileAttached: false },
          ready: true,
          sshHostKey: HOST_KEY,
        },
      ],
      expectedError: null,
      expectedCommands: ["warmup", "inspect", "inspect", "run", "inspect"],
    },
    {
      state: "pending-forbidden",
      inspections: [
        {
          providerMetadata: { instanceProfileAttached: true },
          ready: false,
        },
      ],
      expectedError: "Crabbox AWS inspect must attest that no instance profile is attached",
      expectedCommands: ["warmup", "inspect", "stop"],
    },
    {
      state: "ready-metadata-missing",
      inspections: [{ providerMetadata: undefined, ready: true, sshHostKey: HOST_KEY }],
      expectedError: "Crabbox AWS inspect must attest that no instance profile is attached",
      expectedCommands: ["warmup", "inspect", "stop"],
    },
  ])(
    "enforces AWS instance-profile attestation across the $state sequence",
    async ({ inspections, expectedError, expectedCommands }) => {
      const calls: string[][] = [];
      let inspectionIndex = 0;
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          const inspection = inspections[inspectionIndex] ?? inspections.at(-1);
          if (!inspection) {
            throw new Error("missing inspection fixture");
          }
          inspectionIndex += 1;
          return commandResult({ stdout: inspectJson(inspection) });
        }
        return commandResult();
      });

      const provision = provider.provision(PROFILE, OPERATION_ID);
      if (expectedError) {
        await expect(provision).rejects.toMatchObject({
          code: "invalid_profile",
          message: expectedError,
        });
      } else {
        await expect(provision).resolves.toMatchObject({ leaseId: LEASE_ID });
      }
      expect(calls.map((argv) => argv[1])).toEqual(expectedCommands);
    },
  );

  it.each([
    {
      field: "provider metadata",
      overrides: { providerMetadata: { instanceProfileAttached: "no" } },
    },
    { field: "Tailscale state", overrides: { tailscale: null } },
  ])("stops a fixed lease with malformed $field", async ({ overrides }) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "stop") {
        return commandResult();
      }
      return commandResult({ stdout: inspectJson(overrides) });
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringMatching(/Crabbox inspect returned invalid/u),
    });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it.each([
    ["invalid JSON", commandResult({ stdout: "{" }), "Crabbox inspect returned invalid JSON"],
    [
      "expected-id mismatch",
      commandResult({ stdout: inspectJson({ id: "cbx_ffffffffffff" }) }),
      "Crabbox inspect returned a different lease id",
    ],
  ])("stops a fixed lease on permanent %s", async (_name, inspectResult, message) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "stop") {
        return commandResult();
      }
      return argv[1] === "inspect" ? inspectResult : commandResult();
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message,
    });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("stops a fixed lease that has Tailscale state", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({
          stdout: inspectJson({ sshHostKey: HOST_KEY, tailscale: { enabled: true } }),
        });
      }
      return commandResult();
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox cloud worker lease must not have Tailscale enabled",
    });
    expect(calls.some((argv) => argv[1] === "warmup")).toBe(true);
    expect(calls.some((argv) => argv[1] === "stop" && argv.includes(LEASE_ID))).toBe(true);
  });

  it("rejects a blank profile setup command", async () => {
    const provider = providerWithRunner(async () => commandResult());
    await expect(provider.provision({ ...PROFILE, setup: "  " }, "provision:x")).rejects.toThrow(
      "Crabbox profile setup must be a non-empty command string",
    );
  });

  it.each([
    [`provision:v2:${"0".repeat(64)}`, "cbx_6071fc2062a6"],
    [`provision:v2:${"a".repeat(64)}`, "cbx_d75d2e596dde"],
  ])("derives canonical fixed lease id for %s", (operationId, expected) => {
    expect(operationLeaseId(operationId)).toBe(expected);
    expect(operationLeaseId(operationId)).toMatch(/^cbx_[a-f0-9]{12}$/u);
  });

  it("rejects a non-boolean desktop profile setting", async () => {
    const provider = providerWithRunner(async () => commandResult());
    await expect(provider.provision({ ...PROFILE, desktop: "yes" }, OPERATION_ID)).rejects.toThrow(
      "Crabbox profile desktop must be a boolean",
    );
  });

  it("rejects desktop profiles outside the supported provider set before allocation", async () => {
    const runCommand = vi.fn<CrabboxCommandRunner>();
    const provider = providerWithRunner(runCommand);

    await expect(
      provider.provision({ ...PROFILE, provider: "azure", desktop: true }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox desktop profiles support only AWS and coordinator-backed Hetzner",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "direct",
      config: { coordinator: "", brokerMode: "managed" },
    },
    {
      name: "registered",
      config: {
        coordinator: "https://coordinator.example.test",
        brokerMode: "registered",
      },
    },
  ])("rejects a $name Hetzner desktop profile before allocation", async ({ config }) => {
    const calls: string[][] = [];
    const provider = providerWithRawRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify(config) });
      }
      return commandResult();
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "hetzner", desktop: true }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: "Crabbox Hetzner desktop profiles require a managed coordinator",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["config"]);
  });

  it.each([
    {
      name: "direct AWS",
      providerId: "aws",
      config: { aws: { instanceProfile: "" }, coordinator: "", brokerMode: "managed" },
    },
    {
      name: "coordinator-backed AWS",
      providerId: "aws",
      config: {
        aws: { instanceProfile: "" },
        coordinator: "https://coordinator.example.test",
        brokerMode: "managed",
      },
    },
    {
      name: "coordinator-backed Hetzner",
      providerId: "hetzner",
      config: {
        coordinator: "https://coordinator.example.test",
        brokerMode: "managed",
      },
    },
  ])("provisions a node-carried desktop through $name", async ({ config, providerId }) => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const setupOrder: string[] = [];
    const provider = providerWithRawRunner(async (argv, options) => {
      calls.push({ argv, options });
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify(config) });
      }
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run" && String(options.input).includes("openclaw-worker-browser")) {
        setupOrder.push("desktop");
      }
      return commandResult();
    });

    await expect(
      provider.provision({ ...PROFILE, provider: providerId, desktop: true }, OPERATION_ID, {
        beginNodeEnrollment: async () => {
          setupOrder.push("enrollment");
          return {
            mode: "connect" as const,
            setupCode: "secret-setup-value",
            setupId: "setup-id",
            openclawVersion: "2026.8.1",
            packageSpecs: ["openclaw@2026.8.1"],
            displayName: "Cloud worker test",
            waitForDeviceId: async () => "device-1",
          };
        },
      }),
    ).resolves.toEqual({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
      sharedHost: false,
      desktop: {
        protocol: "rfb",
        port: 5900,
        passwordFilePath: "/var/lib/crabbox/vnc.password",
        apps: [
          {
            id: "browser",
            executablePath: "/usr/local/bin/openclaw-worker-browser",
            cdpPort: 9222,
          },
          {
            id: "terminal",
            executablePath: "/usr/local/bin/openclaw-worker-terminal",
          },
        ],
      },
    });
    expect(calls.find((call) => call.argv[1] === "warmup")).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({ timeoutMs: 50 * 60_000 }),
      }),
    );
    expect(calls.find((call) => call.argv[1] === "warmup")?.argv.slice(-4)).toEqual([
      "--desktop",
      "--browser",
      "--desktop-env",
      "xfce",
    ]);
    expect(
      provider.resolveProvisionTimeoutMs?.({
        ...PROFILE,
        provider: providerId,
        desktop: true,
      }),
    ).toBe(72 * 60_000);
    expect(setupOrder).toEqual(["desktop", "enrollment"]);
  });

  it.each(["desktop setup", "enrollment preparation", "enrollment completion"] as const)(
    "stops the fixed desktop lease after permanent %s failure",
    async (failurePoint) => {
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv, options) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
        }
        if (
          failurePoint === "desktop setup" &&
          argv[1] === "run" &&
          String(options.input).includes("openclaw-worker-browser")
        ) {
          return commandResult({ code: 9, stderr: "desktop setup failed" });
        }
        return commandResult();
      });

      await expect(
        provider.provision({ ...PROFILE, desktop: true }, OPERATION_ID, {
          beginNodeEnrollment: async () => {
            if (failurePoint === "enrollment preparation") {
              throw new Error("enrollment preparation failed");
            }
            return {
              mode: "resume" as const,
              deviceId: "device-bound",
              openclawVersion: "2026.8.1",
              packageSpecs: ["openclaw@2026.8.1"],
              displayName: "Bound worker",
              waitForDeviceId: async () => {
                if (failurePoint === "enrollment completion") {
                  throw new Error("enrollment completion failed");
                }
                return "device-bound";
              },
            };
          },
        }),
      ).rejects.toThrow(failurePoint === "desktop setup" ? "setup failed" : failurePoint);
      expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
    },
  );

  it("collects redacted node evidence before stopping an unenrolled lease", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const pairingSecret = "pairing-secret-value-0123456789";
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run" && String(options.input).includes("node.log tail:")) {
        return commandResult({
          stdout: [
            "package-spec=openclaw@2026.8.1 node-pid=alive node.log tail:",
            `gateway rejected websocket upgrade (HTTP 403): proxy_attribution_required token=${pairingSecret}`,
          ].join(" "),
        });
      }
      return commandResult();
    });

    const originalError = new Error("Worker node did not connect before the enrollment deadline");
    const error = await provider
      .provision(PROFILE, OPERATION_ID, failedNodeEnrollment(originalError))
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      cause: originalError,
      message: expect.stringContaining(
        "Worker node did not connect before the enrollment deadline; box evidence: package-spec=openclaw@2026.8.1 node-pid=alive node.log tail:",
      ),
    });
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("proxy_attribution_required");
    expect(message).not.toContain(pairingSecret);

    const diagnosticCall = calls.find(
      ({ argv, options }) => argv[1] === "run" && String(options.input).includes("node.log tail:"),
    );
    expect(diagnosticCall?.argv).toEqual([
      SIBLING_BINARY,
      "run",
      "--provider",
      "aws",
      "--network",
      "public",
      "--tailscale=false",
      "--id",
      LEASE_ID,
      "--keep=true",
      "--no-sync",
      "--script-stdin",
    ]);
    expect(diagnosticCall?.options.timeoutMs).toBe(60_000);
    expect(diagnosticCall?.options.env).toBeUndefined();
    expect(String(diagnosticCall?.options.input)).toContain(`cloud-workers/${LEASE_ID}`);
    expect(String(diagnosticCall?.options.input)).not.toContain("setup-code");
    expect(calls.slice(-2).map(({ argv }) => argv[1])).toEqual(["run", "stop"]);
  });

  it.each([
    {
      name: "exits unsuccessfully",
      result: commandResult({ code: 9, stderr: "SSH transport unavailable" }),
      reason: "Crabbox enrollment diagnostics failed with exit code 9: SSH transport unavailable",
    },
    {
      name: "times out",
      result: commandResult({ code: null, killed: true, termination: "timeout" }),
      reason: "Crabbox enrollment diagnostics did not exit normally (timeout)",
    },
    {
      name: "cannot start",
      result: undefined,
      reason: "Crabbox enrollment diagnostics could not start",
    },
  ])("preserves enrollment failure when evidence collection $name", async ({ result, reason }) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv, options) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run" && String(options.input).includes("node.log tail:")) {
        if (!result) {
          throw new Error("spawn failed token=diagnostic-secret-value-0123456789");
        }
        return result;
      }
      return commandResult();
    });

    const originalError = new Error("Worker node did not connect before the enrollment deadline");
    await expect(
      provider.provision(PROFILE, OPERATION_ID, failedNodeEnrollment(originalError)),
    ).rejects.toMatchObject({
      cause: originalError,
      message: `${originalError.message}; box evidence unavailable: ${reason}`,
    });
    expect(calls.slice(-2).map((argv) => argv[1])).toEqual(["run", "stop"]);
  });

  it.each([
    {
      name: "a surrogate pair at the byte boundary",
      output: `${"x".repeat(2_033)}😀secret-tail`,
      expected: "x".repeat(2_033),
    },
    {
      name: "multibyte Unicode output",
      output: "😀".repeat(800),
      expected: "😀".repeat(508),
    },
  ])("bounds enrollment evidence for $name", async ({ output, expected }) => {
    const provider = providerWithRunner(async (argv, options) => {
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run" && String(options.input).includes("node.log tail:")) {
        return commandResult({ stdout: output });
      }
      return commandResult();
    });

    const originalError = new Error("Worker node did not connect before the enrollment deadline");
    const error = await provider
      .provision(PROFILE, OPERATION_ID, failedNodeEnrollment(originalError))
      .catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : "";
    const evidence = message.split("; ")[1] ?? "";

    expect(evidence).toBe(`box evidence: ${expected}`);
    expect(Buffer.byteLength(evidence, "utf8")).toBeLessThanOrEqual(2_048);
    expect(hasLoneSurrogate(message)).toBe(false);
  });

  it.each(["preparation", "completion", "diagnostics"] as const)(
    "preserves its fixed lease when the Gateway aborts enrollment %s",
    async (phase) => {
      const calls: string[][] = [];
      const controller = new AbortController();
      const provider = providerWithRunner(async (argv, options) => {
        calls.push(argv);
        if (
          phase === "diagnostics" &&
          argv[1] === "run" &&
          String(options.input).includes("node.log tail:")
        ) {
          controller.abort();
          return commandResult({ stdout: "package-spec=absent node-pid=dead-or-absent" });
        }
        return argv[1] === "inspect"
          ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
          : commandResult();
      });

      await expect(
        provider.provision(PROFILE, OPERATION_ID, {
          beginNodeEnrollment: async () => {
            if (phase === "preparation") {
              controller.abort();
              controller.signal.throwIfAborted();
            }
            return {
              mode: "resume" as const,
              deviceId: "device-bound",
              openclawVersion: "2026.8.1",
              packageSpecs: ["openclaw@2026.8.1"],
              displayName: "Bound worker",
              signal: controller.signal,
              waitForDeviceId: async () => {
                if (phase === "diagnostics") {
                  throw new Error("Worker node did not connect before the enrollment deadline");
                }
                controller.abort();
                controller.signal.throwIfAborted();
                return "device-bound";
              },
            };
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(calls.some((argv) => argv[1] === "stop")).toBe(false);
    },
  );

  it("runs one fixed warmup, ignores its output, and inspects only the canonical id", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      return argv[1] === "warmup"
        ? commandResult({ stdout: "warmup completed without a lease token\n" })
        : commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).resolves.toMatchObject({
      leaseId: LEASE_ID,
    });
    expect(calls).toHaveLength(4);
    expect(calls[0]?.argv).toEqual([
      SIBLING_BINARY,
      "warmup",
      "--provider",
      "aws",
      "--network",
      "public",
      "--tailscale=false",
      "--class",
      "standard",
      "--ttl",
      "24h",
      "--idle-timeout",
      "60m",
      "--lease-id",
      LEASE_ID,
      "--slug",
      expect.stringMatching(/^openclaw-[a-f0-9]{32}$/u),
      "--keep=true",
    ]);
    expect(calls[0]?.options).toEqual({
      timeoutMs: 240_000,
      maxOutputBytes: 65_536,
      killProcessTree: true,
    });
    expect(calls[1]?.argv).toEqual([
      SIBLING_BINARY,
      "inspect",
      "--provider",
      "aws",
      "--network",
      "public",
      "--id",
      LEASE_ID,
      "--json",
    ]);
    expect(calls[2]?.argv[1]).toBe("run");
    expect(String(calls[2]?.options.input)).toContain("openclaw@2026.8.1");
    expect(String(calls[2]?.options.input)).toContain("'OpenClaw 2026.8.1'|'OpenClaw 2026.8.1 '*");
    expect(String(calls[2]?.options.input)).toContain(
      'npx --yes --package "$package_spec" -- openclaw',
    );
    expect(String(calls[2]?.options.input)).toContain(
      "OpenClaw worker bootstrap could not install Gateway version 2026.8.1",
    );
    expect(String(calls[2]?.options.input)).toContain(
      'connect --target-file "$setup_code_file" --ephemeral',
    );
    expect(String(calls[2]?.options.input)).toContain("setsid -f sh -c");
    expect(String(calls[2]?.options.input)).not.toContain("config set nodeHost.workerRuns.enabled");
    expect(String(calls[2]?.options.input)).not.toContain("nohup");
    expect(String(calls[2]?.options.input)).not.toContain("secret-setup-value");
    expect(calls[2]?.options.env).toMatchObject({
      CRABBOX_WORKER_SETUP_CODE: "secret-setup-value",
    });
    expect(calls[2]?.argv).toEqual(
      expect.arrayContaining(["--allow-env", "CRABBOX_WORKER_SETUP_CODE"]),
    );
    expect(calls[2]?.argv.join(" ")).not.toContain("setup-code");
    expect(calls[3]?.argv[1]).toBe("inspect");
  });

  it("overrides the configured class for one provision operation", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return argv[1] === "warmup"
        ? commandResult()
        : commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
    });

    await provider.provision(PROFILE, OPERATION_ID, { machineClass: "c7a.24xlarge" });

    const warmup = calls.find((argv) => argv[1] === "warmup");
    expect(warmup?.slice(warmup.indexOf("--class"), warmup.indexOf("--class") + 2)).toEqual([
      "--class",
      "c7a.24xlarge",
    ]);
  });

  it.each([" ", "x".repeat(129)])(
    "rejects an invalid per-operation machine class before allocation",
    async (machineClass) => {
      const runCommand = vi.fn(async () => commandResult());
      const provider = providerWithRunner(runCommand);

      await expect(
        provider.provision(PROFILE, OPERATION_ID, { machineClass }),
      ).rejects.toMatchObject({ code: "invalid_profile" });
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it("replays a committed timed-out warmup through a fresh provider instance", async () => {
    const calls: string[][] = [];
    const live = new Set<string>();
    let creates = 0;
    let loseFirstReply = true;
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      const idFlag = argv.indexOf("--id");
      const leaseIdFlag = argv.indexOf("--lease-id");
      const id = argv[idFlag >= 0 ? idFlag + 1 : leaseIdFlag + 1] ?? "";
      if (argv[1] === "warmup") {
        if (!live.has(id)) {
          creates += 1;
          live.add(id);
        }
        if (loseFirstReply) {
          loseFirstReply = false;
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        return commandResult();
      }
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson({ id, sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      if (argv[1] === "stop") {
        live.delete(id);
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    };

    const desktopProfile = { ...PROFILE, desktop: true };
    await expect(
      providerWithRunner(runCommand).provision(desktopProfile, OPERATION_ID),
    ).rejects.toThrow("did not exit normally (timeout)");
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);

    const restarted = providerWithRunner(runCommand);
    const lease = await restarted.provision(desktopProfile, OPERATION_ID);
    await restarted.destroy({ leaseId: lease.leaseId, profile: desktopProfile });

    expect(creates).toBe(1);
    expect(lease.leaseId).toBe(LEASE_ID);
    expect(lease.desktop).toMatchObject({
      protocol: "rfb",
      port: 5900,
      apps: [{ id: "browser" }, { id: "terminal" }],
    });
    expect(live.size).toBe(0);
    expect(calls.filter((argv) => argv[1] === "warmup")).toHaveLength(2);
    expect(calls.filter((argv) => argv[1] === "inspect")).toHaveLength(3);
    expect(calls.filter((argv) => argv[1] === "inspect")).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["--id", LEASE_ID]),
        expect.arrayContaining(["--id", LEASE_ID]),
        expect.arrayContaining(["--id", LEASE_ID]),
      ]),
    );
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it("keeps a committed lease live after inspect timeout and adopts it on replay", async () => {
    const calls: string[][] = [];
    const live = new Set<string>();
    let creates = 0;
    let inspections = 0;
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      const idFlag = argv.indexOf("--id");
      const leaseIdFlag = argv.indexOf("--lease-id");
      const id = argv[idFlag >= 0 ? idFlag + 1 : leaseIdFlag + 1] ?? "";
      if (argv[1] === "warmup") {
        if (!live.has(id)) {
          creates += 1;
          live.add(id);
        }
        return commandResult();
      }
      if (argv[1] === "inspect") {
        inspections += 1;
        return inspections === 1
          ? commandResult({ code: null, killed: true, termination: "timeout" })
          : commandResult({ stdout: inspectJson({ id, sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run") {
        return commandResult();
      }
      if (argv[1] === "stop") {
        live.delete(id);
        return commandResult();
      }
      throw new Error(`unexpected Crabbox command: ${argv[1]}`);
    };

    await expect(providerWithRunner(runCommand).provision(PROFILE, OPERATION_ID)).rejects.toThrow(
      "did not exit normally (timeout)",
    );
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
    expect(live).toEqual(new Set([LEASE_ID]));

    const restarted = providerWithRunner(runCommand);
    const lease = await restarted.provision(PROFILE, OPERATION_ID);
    expect(lease.leaseId).toBe(LEASE_ID);
    expect(creates).toBe(1);
    expect(live).toEqual(new Set([LEASE_ID]));

    await restarted.destroy({ leaseId: lease.leaseId, profile: PROFILE });
    expect(live.size).toBe(0);
    expect(calls.map((argv) => argv[1])).toEqual([
      "warmup",
      "inspect",
      "warmup",
      "inspect",
      "run",
      "inspect",
      "stop",
    ]);
  });

  it.each([
    [
      "spawn failure",
      async (): Promise<SpawnResult> => {
        throw new Error("spawn failed");
      },
      "Crabbox inspect could not start",
    ],
    [
      "non-authoritative CLI failure",
      async (): Promise<SpawnResult> => commandResult({ code: 1, stderr: "provider unavailable" }),
      "Crabbox inspect failed with exit code 1",
    ],
  ])("leaves the fixed lease live after transient %s", async (_name, failure, message) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return await failure();
      }
      if (argv[1] === "stop") {
        throw new Error("transient inspection must not stop the lease");
      }
      return commandResult();
    });

    const error = await provider.provision(PROFILE, OPERATION_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: expect.stringContaining(message) });
    expect(error).not.toMatchObject({ code: "invalid_profile" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
  });

  it("keeps authoritative absence after warmup retryable and un-stopped", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
      }
      if (argv[1] === "stop") {
        throw new Error("authoritative absence must not tombstone the fixed ID");
      }
      return commandResult();
    });

    const error = await provider.provision(PROFILE, OPERATION_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "Crabbox warmup lease was not found during inspection",
    });
    expect(error).not.toMatchObject({ code: "invalid_profile" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
  });

  it.each([
    ["old backend", 2, "provider=aws does not support fixed idempotent lease IDs"],
    ["old CLI", 2, "unknown flag: --lease-id"],
    ["intent drift", 4, "lease_id_conflict: lease is bound to another create intent"],
    ["terminal reuse", 4, "lease_id_conflict: fixed lease is terminal and cannot be replayed"],
  ])("treats %s as a permanent provider rejection", async (_name, code, stderr) => {
    const provider = providerWithRunner(async () => commandResult({ code, stderr }));

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("keeps unresolved direct AWS inventory convergence retryable", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult({
        code: 4,
        stderr:
          "lease_id_conflict: fixed AWS lease has an unresolved launch attempt; retry after provider inventory converges",
      });
    });

    const error = await provider.provision(PROFILE, OPERATION_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ code: "invalid_profile" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup"]);
  });

  it("rejects legacy unleased provision state before invoking Crabbox", async () => {
    let invoked = false;
    const provider = providerWithRunner(async () => {
      invoked = true;
      return commandResult();
    });

    await expect(provider.provision(PROFILE, `provision:${"0".repeat(64)}`)).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("cannot be replayed safely"),
    });
    expect(invoked).toBe(false);
  });

  it("keeps readiness polling out of the setup timeout budget", async () => {
    const calls: string[][] = [];
    let nowMs = 1_000;
    let inspections = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        if (argv[1] === "config") {
          return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
        }
        if (argv[1] === "inspect") {
          inspections += 1;
          return commandResult({
            stdout: inspectJson({ ready: inspections > 1, sshHostKey: HOST_KEY }),
          });
        }
        return commandResult();
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: (candidate) => candidate === SIBLING_BINARY,
      sleep: async () => {
        nowMs += 290_001;
      },
      wallpaperPath: WORKER_WALLPAPER_PATH,
    });

    try {
      await expect(
        provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
      ).rejects.toThrow("exceeded its provider deadline");
    } finally {
      now.mockRestore();
    }
    expect(calls.map((argv) => argv[1])).toEqual(["config", "warmup", "inspect"]);
  });

  it("leaves the fixed lease live when readiness polling fails transiently", async () => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        inspections += 1;
        return inspections === 1
          ? commandResult({ stdout: inspectJson({ ready: false }) })
          : commandResult({ code: 1, stderr: "readiness probe failed" });
      }
      return commandResult();
    });

    await expect(provider.provision(PROFILE, OPERATION_ID)).rejects.toThrow(
      "readiness probe failed",
    );
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "inspect"]);
  });

  it.each([
    { profile: {}, message: "provider" },
    { profile: { ...PROFILE, provider: " " }, message: "provider" },
    { profile: { ...PROFILE, class: 4 }, message: "class" },
    { profile: { ...PROFILE, ttl: "" }, message: "ttl" },
    { profile: { ...PROFILE, ttl: "garbage" }, message: "positive Go duration" },
    { profile: { ...PROFILE, ttl: "0.1ns" }, message: "positive Go duration" },
    {
      profile: { ...PROFILE, ttl: "999999999999999999999h" },
      message: "positive Go duration",
    },
    { profile: { ...PROFILE, idleTimeout: false }, message: "idleTimeout" },
    { profile: { ...PROFILE, idleTimeout: "0s" }, message: "positive Go duration" },
    { profile: { ...PROFILE, binary: " " }, message: "binary" },
    { profile: { ...PROFILE, binary: "crabbox" }, message: "absolute path" },
    { profile: { ...PROFILE, typo: true }, message: "unknown" },
  ])("rejects an invalid profile ($message)", async ({ profile, message }) => {
    let invoked = false;
    const provider = providerWithRunner(async () => {
      invoked = true;
      return commandResult();
    });

    await expect(provider.provision(profile, "provision:invalid")).rejects.toThrow(message);
    await expect(provider.provision(profile, "provision:invalid")).rejects.toMatchObject({
      code: "invalid_profile",
    });
    expect(invoked).toBe(false);
  });

  it("rejects a provider unknown to the Crabbox binary as an invalid profile", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({ code: 2, stderr: 'unknown provider "missing-provider"' }),
    );

    await expect(
      provider.provision({ ...PROFILE, provider: "missing-provider" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a Crabbox backend without warmup support as an invalid profile", async () => {
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "warmup") {
        return commandResult({ code: 2, stderr: "provider=wandb does not support warmup" });
      }
      return commandResult({
        code: 4,
        stderr: `wandb sandbox "${argv[argv.indexOf("--id") + 1]}" has no matching local ownership claim`,
      });
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "wandb" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a Crabbox backend without persistent status as an invalid profile", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({
        code: 2,
        stderr:
          "provider=windows-sandbox does not expose persistent status; close the Windows Sandbox window",
      }),
    );

    await expect(
      provider.provision({ ...PROFILE, provider: "windows-sandbox" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a machine class unsupported by the selected Crabbox backend", async () => {
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "warmup") {
        return commandResult({
          code: 2,
          stderr: "--class is not supported for provider=vast; use --vast-gpu-name",
        });
      }
      return commandResult({
        code: 4,
        stderr: `lease/instance not found: ${argv[argv.indexOf("--id") + 1]}`,
      });
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "vast" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("rejects a one-shot Crabbox backend as an invalid worker profile", async () => {
    const provider = providerWithRunner(async () =>
      commandResult({
        code: 2,
        stderr: "provider=mxc is one-shot and does not support status",
      }),
    );

    await expect(
      provider.provision({ ...PROFILE, provider: "mxc" }, OPERATION_ID),
    ).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("routes lifecycle calls from the passed profile context", async () => {
    const binary = path.resolve(path.sep, "custom", "crabbox");
    const calls: string[][] = [];
    const provider = createCrabboxWorkerProvider({
      runCommand: async (argv) => {
        calls.push(argv);
        return argv[1] === "inspect" ? commandResult({ stdout: inspectJson() }) : commandResult();
      },
      openclawRoot: OPENCLAW_ROOT,
      pathEnv: "",
      isExecutable: () => false,
      wallpaperPath: WORKER_WALLPAPER_PATH,
    });
    const lease = lifecycleLease(LEASE_ID, { ...PROFILE, binary, provider: "coder" });

    await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    expect(calls).toEqual([
      [binary, "inspect", "--provider", "coder", "--network", "public", "--id", LEASE_ID, "--json"],
      [binary, "stop", "--provider", "coder", "--id", LEASE_ID],
    ]);
  });

  it.each([
    { idleTimeout: "1s", idleTimeoutMs: 1_000, intervalMs: 500, timeoutMs: 500 },
    { idleTimeout: "2s", idleTimeoutMs: 2_000, intervalMs: 1_000, timeoutMs: 1_000 },
    { idleTimeout: "5s", idleTimeoutMs: 5_000, intervalMs: 2_500, timeoutMs: 2_500 },
    { idleTimeout: "12s", idleTimeoutMs: 12_000, intervalMs: 5_000, timeoutMs: 6_000 },
    { idleTimeout: "30s", idleTimeoutMs: 30_000, intervalMs: 10_000, timeoutMs: 15_000 },
    { idleTimeout: "6m", idleTimeoutMs: 360_000, intervalMs: 60_000, timeoutMs: 150_000 },
    { idleTimeout: "45m", idleTimeoutMs: 2_700_000, intervalMs: 60_000, timeoutMs: 150_000 },
  ])(
    "heartbeats an active lease every $intervalMs ms for idleTimeout=$idleTimeout",
    async ({ idleTimeout, idleTimeoutMs, intervalMs, timeoutMs }) => {
      vi.useFakeTimers();
      const calls: string[][] = [];
      const heartbeatTimeouts: number[] = [];
      const profile = { ...PROFILE, idleTimeout };
      const provider = providerWithRunner(async (argv, options) => {
        calls.push(argv);
        if (argv[1] === "heartbeat") {
          heartbeatTimeouts.push(options.timeoutMs);
        }
        return argv[1] === "inspect"
          ? commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) })
          : commandResult();
      });
      const heartbeatCalls = () => calls.filter((argv) => argv[1] === "heartbeat");

      try {
        await expect(provider.provision(profile, OPERATION_ID)).resolves.toMatchObject({
          leaseId: LEASE_ID,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(heartbeatCalls()).toEqual([
          [
            SIBLING_BINARY,
            "heartbeat",
            "--provider",
            "aws",
            "--id",
            LEASE_ID,
            "--idle-timeout",
            idleTimeout,
            "--json",
          ],
        ]);
        expect(heartbeatTimeouts).toEqual([timeoutMs]);

        await vi.advanceTimersByTimeAsync(intervalMs - 1);
        expect(heartbeatCalls()).toHaveLength(1);
        expect(intervalMs).toBeLessThan(idleTimeoutMs);
        await vi.advanceTimersByTimeAsync(1);
        expect(heartbeatCalls()).toHaveLength(2);
      } finally {
        await provider.destroy(lifecycleLease(LEASE_ID, profile));
        vi.useRealTimers();
      }
    },
  );

  it("aborts heartbeat before provider teardown and never reschedules it", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    let finishStop!: () => void;
    const stopPending = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const provider = providerWithRunner(async (argv, options) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson() });
      }
      if (argv[1] === "heartbeat") {
        return await new Promise<SpawnResult>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve(commandResult({ code: null, termination: "signal" })),
            { once: true },
          );
        });
      }
      if (argv[1] === "stop") {
        await stopPending;
      }
      return commandResult();
    });
    const lease = lifecycleLease();

    try {
      await provider.inspect(lease);
      void vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1),
      );

      const destroy = provider.destroy(lease);
      await vi.waitFor(() => expect(calls.some((argv) => argv[1] === "stop")).toBe(true));
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1);
      finishStop();
      await destroy;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1);
    } finally {
      finishStop();
      vi.useRealTimers();
    }
  });

  it("warns once and disables heartbeat when the Crabbox command is unavailable", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];
    const warnings: string[] = [];
    const provider = providerWithRunner(
      async (argv) => {
        calls.push(argv);
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson() });
        }
        if (argv[1] === "heartbeat") {
          return commandResult({ code: 2, stderr: "unexpected argument heartbeat" });
        }
        return commandResult();
      },
      (message) => warnings.push(message),
    );
    const lease = lifecycleLease();

    try {
      await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
      await vi.advanceTimersByTimeAsync(0);
      await provider.inspect(lease);
      await vi.advanceTimersByTimeAsync(180_000);

      expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(1);
      expect(warnings).toEqual([
        `Crabbox heartbeat is unavailable for worker lease ${LEASE_ID}; upgrade Crabbox to v0.44.0 or newer for \`crabbox heartbeat\`; cloud worker machines may be reaped after 60m of coordinator-idle time`,
      ]);
    } finally {
      await provider.destroy(lease);
      vi.useRealTimers();
    }
  });

  it("reports the measured heartbeat duration when the command times out", async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    const provider = providerWithRunner(
      async (argv) => {
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson() });
        }
        if (argv[1] === "heartbeat") {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 60_012);
          });
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        return commandResult();
      },
      (message) => warnings.push(message),
    );
    const lease = lifecycleLease();

    try {
      await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
      await vi.advanceTimersByTimeAsync(60_012);

      expect(warnings).toEqual([
        "Crabbox heartbeat did not exit normally (timeout after 60012 ms); cloud worker machines may be reaped after 60m of coordinator-idle time",
      ]);
    } finally {
      await provider.destroy(lease);
      vi.useRealTimers();
    }
  });

  it("keeps heartbeat transport failures out of lifecycle operations and retries", async () => {
    vi.useFakeTimers();
    let heartbeatAttempts = 0;
    const warnings: string[] = [];
    const provider = providerWithRunner(
      async (argv) => {
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson() });
        }
        if (argv[1] === "heartbeat" && heartbeatAttempts++ === 0) {
          throw new Error("transport unavailable");
        }
        return commandResult();
      },
      (message) => warnings.push(message),
    );
    const lease = lifecycleLease();

    try {
      await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "active" });
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeatAttempts).toBe(1);
      expect(warnings).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(heartbeatAttempts).toBe(2);
      expect(warnings).toHaveLength(1);
    } finally {
      await provider.destroy(lease);
      vi.useRealTimers();
    }
  });

  it("rejects non-Crabbox lifecycle lease ids before invoking the CLI", async () => {
    let invoked = false;
    const provider = providerWithRunner(async () => {
      invoked = true;
      return commandResult();
    });
    const lease = lifecycleLease("lease:not-crabbox");

    await expect(provider.inspect(lease)).rejects.toThrow("lease id is invalid");
    await expect(provider.destroy(lease)).rejects.toThrow("lease id is invalid");
    expect(invoked).toBe(false);
  });

  it.each([
    { state: "running", ready: true, expected: "active" },
    { state: "provisioning", ready: false, expected: "active" },
    { state: "stopped", ready: false, expected: "destroyed" },
    { state: "released", ready: false, expected: "destroyed" },
    { state: "deleted", ready: false, expected: "destroyed" },
    { state: "destroyed", ready: false, expected: "destroyed" },
    { state: "deleting", ready: false, expected: "active" },
    { state: "failed", ready: false, expected: "active" },
  ])("maps inspect state $state to $expected", async ({ state, ready, expected }) => {
    const provider = providerWithRunner(async () =>
      commandResult({ stdout: inspectJson({ state, ready }) }),
    );

    await expect(provider.inspect(lifecycleLease())).resolves.toStrictEqual({
      status: expected,
    });
  });

  it("maps only authoritative lease absence to unknown", async () => {
    const missing = providerWithRunner(async () =>
      commandResult({ code: 4, stderr: `lease/droplet not found: ${LEASE_ID}` }),
    );
    const authFailure = providerWithRunner(async () =>
      commandResult({
        code: 4,
        stderr: `credential profile not found while inspecting lease ${LEASE_ID}`,
      }),
    );
    const noLongerExists = providerWithRunner(async () =>
      commandResult({ code: 4, stderr: `unikraftcloud lease ${LEASE_ID} no longer exists` }),
    );
    const ambiguousVisibility = providerWithRunner(async () =>
      commandResult({
        code: 4,
        stderr: `nomad job for lease ${LEASE_ID} is missing or inaccessible`,
      }),
    );
    const cliMissing = providerWithRunner(async () => {
      throw new Error("spawn ENOENT");
    });

    const lease = lifecycleLease();
    await expect(missing.inspect(lease)).resolves.toStrictEqual({ status: "unknown" });
    await expect(noLongerExists.inspect(lease)).resolves.toStrictEqual({ status: "unknown" });
    await expect(authFailure.inspect(lease)).rejects.toThrow("inspect failed with exit code 4");
    await expect(ambiguousVisibility.inspect(lease)).rejects.toThrow(
      "inspect failed with exit code 4",
    );
    await expect(cliMissing.inspect(lease)).rejects.toThrow("inspect could not start");
  });

  it("bounds and redacts CLI failure details", async () => {
    const secret = ["sk", "abcdefghijklmnop"].join("-");
    const provider = providerWithRunner(async () =>
      commandResult({
        code: 2,
        stderr: `${secret} ${"failure ".repeat(200)}`,
        stdout: "stdout must not replace stderr",
      }),
    );

    const error = await provider.inspect(lifecycleLease()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).not.toContain(secret);
    expect(message).not.toContain("stdout must not replace stderr");
    expect(message).toHaveLength(INSPECT_FAILURE_PREFIX.length + 512);
  });

  it("preserves UTF-16 boundaries in provider failure details", async () => {
    const prefix = "x".repeat(511);
    const provider = providerWithRunner(async () =>
      commandResult({ code: 2, stderr: `${prefix}😀after` }),
    );

    const error = await provider.inspect(lifecycleLease()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toBe(`${INSPECT_FAILURE_PREFIX}${prefix}`);
    expect(hasLoneSurrogate(message)).toBe(false);
  });

  it("keeps a complete boundary pair when falling back to stdout", async () => {
    const detail = `${"x".repeat(510)}😀`;
    const provider = providerWithRunner(async () =>
      commandResult({ code: 2, stdout: `${detail}after` }),
    );

    const error = await provider.inspect(lifecycleLease()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toBe(`${INSPECT_FAILURE_PREFIX}${detail}`);
    expect(hasLoneSurrogate(message)).toBe(false);
  });

  it("destroys absent and already-stopped leases idempotently", async () => {
    const calls: string[][] = [];
    const runCommand: CrabboxCommandRunner = async (argv) => {
      calls.push(argv);
      return calls.length === 1
        ? commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` })
        : commandResult({ code: 4, stderr: `lease ${LEASE_ID} already stopped` });
    };
    const provider = providerWithRunner(runCommand);

    const lease = lifecycleLease();
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    expect(calls).toEqual([
      [SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID],
      [SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID],
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

describe("Crabbox binary resolution", () => {
  it("prefers explicit, then sibling, then PATH, then the bare command", () => {
    const toolsDir = path.resolve(path.sep, "tools");
    const pathBinary = path.join(toolsDir, "crabbox");
    const relativePathBinary = path.resolve("relative-tools", "crabbox");
    const explicitBinary = path.resolve(path.sep, "custom", "crabbox");

    expect(
      resolveCrabboxBinary({
        explicit: explicitBinary,
        openclawRoot: OPENCLAW_ROOT,
        isExecutable: () => false,
      }),
    ).toBe(explicitBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: toolsDir,
        isExecutable: (candidate) => candidate === SIBLING_BINARY || candidate === pathBinary,
      }),
    ).toBe(SIBLING_BINARY);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: [path.resolve(path.sep, "not-executable"), toolsDir].join(path.delimiter),
        isExecutable: (candidate) => candidate === pathBinary,
      }),
    ).toBe(pathBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: "relative-tools",
        isExecutable: (candidate) => candidate === relativePathBinary,
      }),
    ).toBe(relativePathBinary);
    expect(
      resolveCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: path.resolve(path.sep, "not-executable"),
        isExecutable: () => false,
      }),
    ).toBe("crabbox");
  });

  it("distinguishes executable discovery from the dispatch fallback", () => {
    const explicitBinary = path.resolve(path.sep, "custom", "crabbox");

    expect(
      findCrabboxBinary({
        explicit: explicitBinary,
        openclawRoot: OPENCLAW_ROOT,
        isExecutable: () => false,
      }),
    ).toBeUndefined();
    expect(
      findCrabboxBinary({
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: path.resolve(path.sep, "not-executable"),
        isExecutable: () => false,
      }),
    ).toBeUndefined();
  });

  it("derives the package root from source and bundled plugin roots", () => {
    expect(resolveOpenClawRoot(path.join(OPENCLAW_ROOT, "extensions", "crabbox"))).toBe(
      OPENCLAW_ROOT,
    );
    expect(resolveOpenClawRoot(path.join(OPENCLAW_ROOT, "dist", "extensions", "crabbox"))).toBe(
      OPENCLAW_ROOT,
    );
  });
});

describe("Crabbox version probe", () => {
  it.each([
    { output: "0.41.1\n", expected: { status: "supported", version: "0.41.1" } },
    { output: "crabbox 0.41.6\n", expected: { status: "supported", version: "0.41.6" } },
    { output: "0.40.9\n", expected: { status: "outdated", version: "0.40.9" } },
  ])("classifies $output", async ({ output, expected }) => {
    const run = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockResolvedValue(commandResult({ stdout: output }));
    try {
      await expect(doctorRuntime.probeCrabboxVersion("/opt/crabbox")).resolves.toEqual(expected);
      expect(run).toHaveBeenCalledWith(
        ["/opt/crabbox", "--version"],
        expect.objectContaining({ timeoutMs: 2_000, killProcessTree: true }),
      );
    } finally {
      run.mockRestore();
    }
  });

  it("turns timeout into an indeterminate result", async () => {
    const run = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockResolvedValue(commandResult({ code: 124, termination: "timeout" }));
    try {
      await expect(doctorRuntime.probeCrabboxVersion("/opt/crabbox")).resolves.toEqual({
        status: "indeterminate",
        reason: "version command timed out after 2000 ms",
      });
    } finally {
      run.mockRestore();
    }
  });
});
