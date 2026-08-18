// Onboard helper tests cover workspace setup, state cleanup, control UI links, and gateway probes.
import * as fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SpawnResult } from "../process/exec-result.js";
import type { RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  formatControlUiSshHint,
  handleReset,
  normalizeGatewayTokenInput,
  openUrl,
  printWizardHeader,
  probeGatewayConfiguredModel,
  probeGatewayReachable,
  resolveBrowserOpenCommand,
  resolveAdvertisedControlUiLinks,
  resolveControlUiLinks,
  resolveLocalControlUiProbeLinks,
  summarizeExistingConfig,
  validateGatewayPasswordInput,
  waitForGatewayReachable,
} from "./onboard-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("printWizardHeader", () => {
  const withColumns = async (columns: number | undefined, run: () => Promise<void>) => {
    const previous = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
    try {
      await run();
    } finally {
      if (previous) {
        Object.defineProperty(process.stdout, "columns", previous);
      } else {
        delete (process.stdout as { columns?: number }).columns;
      }
    }
  };

  it("prints the mascot beside the wordmark with claws above the text line", async () => {
    const log = vi.fn();
    await withColumns(120, () => printWizardHeader({ log } as unknown as RuntimeEnv));
    const output = stripAnsi(String(log.mock.calls[0]?.[0]));
    const rows = output.split("\n");
    // Claw rows stand above the wordmark; its first row shares the mascot body line.
    expect(rows[0]).toBe(" •●●:.        .:●●•");
    expect(rows[3]).toContain("█▀▀▀█ █▀▀▀█ █▀▀▀▀ █▄  █ █▀▀▀▀ █     █▀▀▀█ █   █");
    expect(rows[3]).toContain(" .●●●: •●●●●• :●●●.");
  });

  it("falls back to the plain title on narrow terminals", async () => {
    const log = vi.fn();
    await withColumns(50, () => printWizardHeader({ log } as unknown as RuntimeEnv));
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain("OPENCLAW");
    expect(output).not.toContain("█");
  });
});

const mocks = vi.hoisted(() => ({
  movePathToTrash: vi.fn(async (targetPath: string) => `${targetPath}.trashed`),
  runCommandWithTimeout: vi.fn<
    (
      argv: string[],
      options?: { timeoutMs?: number; windowsVerbatimArguments?: boolean },
    ) => Promise<SpawnResult>
  >(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  })),
  pickPrimaryTailnetIPv4: vi.fn<() => string | undefined>(() => undefined),
  resolveAdvertisedLanHostCore: vi.fn<() => Promise<string | null>>(async () => null),
  probeGateway: vi.fn(),
  deleteWorkspaceState: vi.fn(),
  prepareWorkspaceStateDeletion: vi.fn((workspaceDir: string) => ({ workspaceDir })),
  prepareLegacyWorkspaceStateReset: vi.fn(() => ({ candidates: [] })),
  removeLegacyWorkspaceStateForReset: vi.fn(
    async (): Promise<{ removedPaths: string[]; warnings: string[] }> => ({
      removedPaths: [],
      warnings: [],
    }),
  ),
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
  movePathToTrash: mocks.movePathToTrash,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
}));

vi.mock("../infra/advertised-lan-host.js", () => ({
  resolveAdvertisedLanHostCore: mocks.resolveAdvertisedLanHostCore,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

vi.mock("../agents/workspace-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/workspace-state-store.js")>(
    "../agents/workspace-state-store.js",
  )),
  deleteWorkspaceState: mocks.deleteWorkspaceState,
  prepareWorkspaceStateDeletion: mocks.prepareWorkspaceStateDeletion,
}));

vi.mock("../agents/workspace-legacy-state.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/workspace-legacy-state.js")>(
    "../agents/workspace-legacy-state.js",
  )),
  prepareLegacyWorkspaceStateReset: mocks.prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset: mocks.removeLegacyWorkspaceStateForReset,
}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.movePathToTrash.mockReset();
  mocks.movePathToTrash.mockImplementation(async (targetPath: string) => `${targetPath}.trashed`);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type RunCommandCall = [
  argv: string[],
  options?: { timeoutMs?: number; windowsVerbatimArguments?: boolean },
];

function requireFirstRunCommandCall(): RunCommandCall {
  const [call] = mocks.runCommandWithTimeout.mock.calls;
  if (!call) {
    throw new Error("expected browser open command call");
  }
  return call as RunCommandCall;
}

function expectedTrashSourcePath(targetPath: string): string {
  return path.join(fs.realpathSync(path.dirname(targetPath)), path.basename(targetPath));
}

describe("handleReset", () => {
  it("rejects full-reset workspaces that contain the active onboarding lock", async () => {
    const homeDir = tempDirs.make("openclaw-reset-lock-overlap-");
    const stateDir = path.join(homeDir, "state");
    const migrationDir = path.join(stateDir, "migration");
    const migrationAlias = path.join(homeDir, "migration-alias");
    const lockSidecar = path.join(migrationDir, "onboarding.lock-target.lock");
    const lockSidecarViaAlias = path.join(migrationAlias, "onboarding.lock-target.lock");
    const configPath = path.join(stateDir, "openclaw.json");
    fs.mkdirSync(migrationDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
    fs.symlinkSync(migrationDir, migrationAlias, process.platform === "win32" ? "junction" : "dir");
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    for (const workspaceDir of [
      homeDir,
      stateDir,
      migrationDir,
      migrationAlias,
      lockSidecar,
      lockSidecarViaAlias,
    ]) {
      await expect(
        withEnvAsync(
          {
            HOME: homeDir,
            OPENCLAW_HOME: homeDir,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
          },
          async () => await handleReset("full", workspaceDir, runtime),
        ),
      ).rejects.toThrow("overlaps the active onboarding lock directory");
    }

    expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
  });

  it("uses active profile paths for destructive reset targets", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-profile-"));
    const profileStateDir = path.join(homeDir, ".openclaw-work");
    const defaultStateDir = path.join(homeDir, ".openclaw");
    const profileConfigPath = path.join(profileStateDir, "openclaw.json");
    const profileCredentialsDir = path.join(profileStateDir, "credentials");
    const profileSessionsDir = path.join(profileStateDir, "agents", "main", "sessions");
    const secondarySessionsDir = path.join(profileStateDir, "agents", "ops", "sessions");
    const workspaceDir = path.join(profileStateDir, "workspace");
    const defaultCredentialsDir = path.join(defaultStateDir, "credentials");

    fs.mkdirSync(profileCredentialsDir, { recursive: true });
    fs.mkdirSync(profileSessionsDir, { recursive: true });
    fs.mkdirSync(secondarySessionsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(defaultCredentialsDir, { recursive: true });
    fs.writeFileSync(profileConfigPath, "{}\n");

    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    const expectedTrashedPaths = [
      profileConfigPath,
      profileCredentialsDir,
      profileSessionsDir,
      secondarySessionsDir,
      workspaceDir,
    ].map(expectedTrashSourcePath);
    const expectedDefaultCredentialsDir = expectedTrashSourcePath(defaultCredentialsDir);

    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: profileStateDir,
          OPENCLAW_CONFIG_PATH: profileConfigPath,
        },
        async () => await handleReset("full", workspaceDir, runtime),
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }

    const trashedPaths = mocks.movePathToTrash.mock.calls.map(([targetPath]) => targetPath);
    expect(trashedPaths).toEqual(expectedTrashedPaths);
    expect(trashedPaths).not.toContain(expectedDefaultCredentialsDir);
    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
  });

  it("rejects a config-only reset when the existing config cannot be trashed", async () => {
    const homeDir = tempDirs.make("openclaw-reset-config-failure-");
    const configPath = path.join(homeDir, "openclaw.json");
    fs.writeFileSync(configPath, "{}\n");
    mocks.movePathToTrash.mockRejectedValueOnce(new Error("trash unavailable"));
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    await withEnvAsync(
      { HOME: homeDir, OPENCLAW_HOME: homeDir, OPENCLAW_CONFIG_PATH: configPath },
      async () => {
        await expect(handleReset("config", "unused", runtime)).rejects.toThrow(configPath);
      },
    );

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to move to Trash \(manual delete\): .*openclaw\.json$/),
    );
  });

  it("reports config, credentials, and session failures together", async () => {
    const homeDir = tempDirs.make("openclaw-reset-state-failures-");
    const stateDir = path.join(homeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const credentialsDir = path.join(stateDir, "credentials");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(configPath, "{}\n");
    mocks.movePathToTrash.mockRejectedValue(new Error("trash unavailable"));
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      },
      async () => {
        await expect(handleReset("config+creds+sessions", "unused", runtime)).rejects.toThrow(
          new RegExp(
            [configPath, credentialsDir, sessionsDir]
              .map((targetPath) => targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join("[\\s\\S]*"),
          ),
        );
      },
    );
  });

  it("deduplicates unreadable session state while still attempting workspace removal", async () => {
    const homeDir = tempDirs.make("openclaw-reset-session-enumeration-");
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(stateDir, "agents");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const inspectError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const readdir = vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(inspectError);
    mocks.movePathToTrash.mockRejectedValueOnce(new Error("trash unavailable"));
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        },
        async () => {
          const failure = await handleReset("full", workspaceDir, runtime).catch(
            (error: unknown) => error,
          );
          expect(failure).toEqual(
            new Error(`Reset failed to remove required state:\n${workspaceDir}`),
          );
        },
      );
    } finally {
      readdir.mockRestore();
    }

    expect(mocks.movePathToTrash).toHaveBeenCalledWith(expectedTrashSourcePath(workspaceDir), {
      allowedRoots: [path.dirname(expectedTrashSourcePath(workspaceDir))],
    });
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
  });

  it("attempts workspace removal even when state deletion planning fails", async () => {
    const homeDir = tempDirs.make("openclaw-reset-workspace-plan-");
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    mocks.prepareWorkspaceStateDeletion.mockImplementationOnce(() => {
      throw new Error("workspace state unavailable");
    });

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () => {
        await expect(
          handleReset("full", workspaceDir, { log: vi.fn() } as unknown as RuntimeEnv),
        ).rejects.toThrow(`${workspaceDir} (workspace state)`);
      },
    );

    expect(mocks.movePathToTrash).toHaveBeenCalledWith(expectedTrashSourcePath(workspaceDir), {
      allowedRoots: [path.dirname(expectedTrashSourcePath(workspaceDir))],
    });
    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
  });

  it("fails closed after attempting workspace state cleanup when retired state remains", async () => {
    const homeDir = tempDirs.make("openclaw-reset-retired-state-");
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    const warning = `Could not remove retired workspace state at ${workspaceDir}.attested`;
    fs.mkdirSync(workspaceDir, { recursive: true });
    mocks.removeLegacyWorkspaceStateForReset.mockResolvedValueOnce({
      removedPaths: [],
      warnings: [warning],
    });
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () => {
        await expect(handleReset("full", workspaceDir, runtime)).rejects.toThrow(warning);
      },
    );

    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
    expect(runtime.log).toHaveBeenCalledWith(warning);
  });

  it("reports rejected retired and workspace state cleanup after attempting both", async () => {
    const homeDir = tempDirs.make("openclaw-reset-state-cleanup-rejections-");
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    mocks.removeLegacyWorkspaceStateForReset.mockRejectedValueOnce(
      new Error("retired state unavailable"),
    );
    mocks.deleteWorkspaceState.mockImplementationOnce(() => {
      throw new Error("state database unavailable");
    });

    const reset = withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () =>
        await handleReset("full", workspaceDir, {
          log: vi.fn(),
        } as unknown as RuntimeEnv),
    );

    await expect(reset).rejects.toThrow(`${workspaceDir} (retired workspace state)`);
    await expect(reset).rejects.toThrow(`${workspaceDir} (workspace state)`);
    expect(mocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
  });

  it("reports a workspace state deletion failure after trash succeeds", async () => {
    const homeDir = tempDirs.make("openclaw-reset-state-delete-");
    const stateDir = path.join(homeDir, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    mocks.deleteWorkspaceState.mockImplementationOnce(() => {
      throw new Error("state database unavailable");
    });

    await withEnvAsync(
      {
        HOME: homeDir,
        OPENCLAW_HOME: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () => {
        await expect(
          handleReset("full", workspaceDir, { log: vi.fn() } as unknown as RuntimeEnv),
        ).rejects.toThrow(`${workspaceDir} (workspace state)`);
      },
    );
  });

  it("retains workspace state when workspace removal fails", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reset-profile-"));
    const profileStateDir = path.join(homeDir, ".openclaw-work");
    const profileConfigPath = path.join(profileStateDir, "openclaw.json");
    const profileCredentialsDir = path.join(profileStateDir, "credentials");
    const profileSessionsDir = path.join(profileStateDir, "agents", "main", "sessions");
    const workspaceDir = path.join(profileStateDir, "workspace");

    fs.mkdirSync(profileCredentialsDir, { recursive: true });
    fs.mkdirSync(profileSessionsDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(profileConfigPath, "{}\n");

    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    mocks.movePathToTrash
      .mockResolvedValueOnce("config.trashed")
      .mockResolvedValueOnce("credentials.trashed")
      .mockResolvedValueOnce("sessions.trashed")
      .mockRejectedValueOnce(new Error("trash unavailable"));

    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: profileStateDir,
          OPENCLAW_CONFIG_PATH: profileConfigPath,
        },
        async () => {
          await expect(handleReset("full", workspaceDir, runtime)).rejects.toThrow(workspaceDir);
        },
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }

    expect(mocks.deleteWorkspaceState).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to move to Trash \(manual delete\): .*workspace$/),
    );
  });
});

describe("openUrl", () => {
  it("passes OAuth URLs to Windows FileProtocolHandler without cmd parsing", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("NODE_ENV", "development");
    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");

    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost";

    await withMockedPlatform("win32", async () => {
      const ok = await openUrl(url);
      expect(ok).toBe(true);

      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
      const [argv, options] = requireFirstRunCommandCall();
      expect(argv).toEqual([rundll32, "url.dll,FileProtocolHandler", url]);
      expect(options?.timeoutMs).toBe(5_000);
      expect(options?.windowsVerbatimArguments).toBeUndefined();
    });
  });

  it("does not pass non-http URLs to the OS browser handler", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");

    await withMockedPlatform("win32", async () => {
      const ok = await openUrl("file://C:/Users/test/secrets.txt");

      expect(ok).toBe(false);
      expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    });
  });
});

describe("resolveBrowserOpenCommand", () => {
  it("uses trusted rundll32 on win32", async () => {
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const rundll32 = path.win32.join("C:\\Windows", "System32", "rundll32.exe");

    await withMockedPlatform("win32", async () => {
      const resolved = await resolveBrowserOpenCommand();
      expect(resolved.argv).toEqual([rundll32, "url.dll,FileProtocolHandler"]);
      expect(resolved.command).toBe(rundll32);
    });
  });
});

describe("formatControlUiSshHint", () => {
  it("includes the IPv4-only BYOH note and workaround", () => {
    const hint = formatControlUiSshHint({ port: 18789 });
    expect(hint).toContain("BYOH note: lan, tailnet, and custom bind are currently IPv4-only.");
    expect(hint).toContain(
      "If your host is IPv6-only, use an IPv4 sidecar or proxy in front of the Gateway.",
    );
  });
});

describe("probeGatewayReachable", () => {
  it("uses a hello-only probe for onboarding reachability", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: 42,
      error: null,
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await probeGatewayReachable({
      url: "ws://127.0.0.1:18789",
      token: "tok_test",
      timeoutMs: 2500,
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:18789",
      timeoutMs: 2500,
      auth: {
        token: "tok_test",
        password: undefined,
      },
      detailLevel: "none",
    });
  });

  it("returns the probe error detail on failure", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "connect failed: timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await probeGatewayReachable({
      url: "ws://127.0.0.1:18789",
    });

    expect(result).toEqual({
      ok: false,
      detail: "connect failed: timeout",
    });
  });

  it("bounds thrown probe errors without splitting UTF-16", async () => {
    const detail = `${"x".repeat(118)}…`;
    const params = { url: "ws://127.0.0.1:18789" };
    mocks.probeGateway.mockRejectedValue(new Error(`${"x".repeat(118)}🚀tail\nignored`));
    expect(await probeGatewayReachable(params)).toEqual({ ok: false, detail });
    expect(await probeGatewayConfiguredModel(params)).toEqual({ kind: "unreachable", detail });
  });

  it("forwards a configured TLS fingerprint to the gateway probe", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: null,
    });

    await expect(
      probeGatewayReachable({
        url: "wss://gateway.example.com:18789",
        tlsFingerprint: "sha256:11:22:33:44",
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "wss://gateway.example.com:18789",
      timeoutMs: 1500,
      auth: {
        token: undefined,
        password: undefined,
      },
      tlsFingerprint: "sha256:11:22:33:44",
      detailLevel: "none",
    });
  });

  it("lets a configured preauth handshake timeout widen the default probe budget", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      configSnapshot: null,
    });

    await expect(
      probeGatewayReachable({
        url: "wss://gateway.example.com:18789",
        preauthHandshakeTimeoutMs: 30_000,
      }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.probeGateway).toHaveBeenCalledWith({
      url: "wss://gateway.example.com:18789",
      timeoutMs: 30_000,
      auth: {
        token: undefined,
        password: undefined,
      },
      preauthHandshakeTimeoutMs: 30_000,
      detailLevel: "none",
    });
  });

  it("classifies configured and missing default-agent models from config-only probes", async () => {
    mocks.probeGateway
      .mockResolvedValueOnce({
        ok: true,
        server: { version: "2026.7.2", connId: "conn-configured" },
        configSnapshot: {
          valid: true,
          config: { agents: { list: [{ id: "work", default: true, model: "openai/gpt-5.5" }] } },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        server: { version: "2026.7.2", connId: "conn-missing" },
        configSnapshot: { valid: true, config: { gateway: { mode: "local" } } },
      });

    await expect(
      probeGatewayConfiguredModel({
        url: "ws://127.0.0.1:18789",
      }),
    ).resolves.toEqual({ kind: "configured" });
    await expect(
      probeGatewayConfiguredModel({
        url: "ws://127.0.0.1:18789",
      }),
    ).resolves.toEqual({
      kind: "missing-configured-model",
      detail: "Gateway default agent has no configured model",
    });
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({ detailLevel: "config" }),
    );
  });

  it("keeps post-Hello config read failures on the reachable Gateway path", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "config.get: unauthorized",
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: "2026.7.2", connId: "conn-1" },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "config.get: unauthorized",
    });
  });

  it("keeps typed pre-Hello Gateway auth failures on the reachable path", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "device pairing required",
      connectErrorDetails: { code: ConnectErrorDetailCodes.PAIRING_REQUIRED },
      auth: { role: null, scopes: [], capability: "pairing_pending" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "device pairing required",
    });
  });

  it("does not mistake an arbitrary open WebSocket for a Gateway", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "websocket closed",
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
      detail: "websocket closed",
    });
  });

  it("does not trust an unrecognized connect error code as Gateway evidence", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "foreign protocol error",
      connectErrorDetails: { code: "NOT_AN_OPENCLAW_CONNECT_ERROR" },
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
      detail: "foreign protocol error",
    });
  });

  it("does not trust a config-shaped response without Gateway handshake evidence", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      connectLatencyMs: 42,
      error: null,
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: "foreign-server", connId: null },
      configSnapshot: {
        valid: true,
        config: { agents: { defaults: { model: "openai/foreign-model" } } },
      },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
    });
  });

  it("keeps a first-time connect-only auth result on the reachable Gateway path", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: 42,
      error: "missing scope: operator.read",
      auth: { role: "operator", scopes: [], capability: "connected_no_operator_scope" },
      server: { version: "2026.7.2", connId: "conn-1" },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "missing scope: operator.read",
    });
  });

  it("treats an invalid config snapshot as reachable but unverified", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: true,
      connectLatencyMs: 42,
      auth: { role: "operator", scopes: ["operator.read"], capability: "read_only" },
      server: { version: "2026.7.2", connId: "conn-1" },
      configSnapshot: { valid: false },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "reachable-unverified",
      detail: "Gateway returned an invalid config snapshot",
    });
  });

  it("distinguishes pre-Hello connection failures from reachable Gateway failures", async () => {
    mocks.probeGateway.mockResolvedValueOnce({
      ok: false,
      connectLatencyMs: null,
      error: "connect failed: timeout",
      auth: { role: null, scopes: [], capability: "unknown" },
      server: { version: null, connId: null },
    });

    await expect(probeGatewayConfiguredModel({ url: "ws://127.0.0.1:18789" })).resolves.toEqual({
      kind: "unreachable",
      detail: "connect failed: timeout",
    });
  });
});

describe("waitForGatewayReachable", () => {
  it("keeps oversized poll intervals within the overall deadline", async () => {
    mocks.probeGateway.mockResolvedValue({
      ok: false,
      url: "ws://127.0.0.1:18789",
      connectLatencyMs: null,
      error: "connect failed: timeout",
      close: null,
      health: null,
      status: null,
      presence: null,
      configSnapshot: null,
    });

    const result = await waitForGatewayReachable({
      url: "ws://127.0.0.1:18789",
      deadlineMs: 5,
      pollMs: Number.MAX_SAFE_INTEGER,
      probeTimeoutMs: 1,
    });

    expect(result).toEqual({ ok: false, detail: "connect failed: timeout" });
  });
});

describe("summarizeExistingConfig", () => {
  it("collapses gateway fields into a friendly remote summary", () => {
    expect(
      summarizeExistingConfig({
        agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
        gateway: {
          mode: "remote",
          port: 18789,
          bind: "lan",
          remote: { url: "ws://192.168.0.202:18789" },
        },
      }),
    ).toBe("Model: openai/gpt-5.4\nGateway: remote via LAN at ws://192.168.0.202:18789");
  });

  it("uses the port when no remote gateway URL is configured", () => {
    expect(
      summarizeExistingConfig({
        gateway: {
          mode: "local",
          port: 18789,
          bind: "loopback",
        },
      }),
    ).toBe("Gateway: local via loopback on :18789");
  });

  it("does not show a stale remote URL as active for local gateway mode", () => {
    expect(
      summarizeExistingConfig({
        gateway: {
          mode: "local",
          port: 18789,
          bind: "loopback",
          remote: { url: "ws://192.168.0.202:18789" },
        },
      }),
    ).toBe("Gateway: local via loopback on :18789");
  });

  it("surfaces missing remote URL instead of falling back to port for remote mode", () => {
    expect(
      summarizeExistingConfig({
        gateway: {
          mode: "remote",
          port: 18789,
          bind: "lan",
        },
      }),
    ).toBe("Gateway: remote via LAN (missing remote URL)");
  });
});

describe("resolveControlUiLinks", () => {
  it("uses customBindHost for custom bind", () => {
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.1.100",
    });
    expect(links.httpUrl).toBe("http://192.168.1.100:18789/");
    expect(links.wsUrl).toBe("ws://192.168.1.100:18789");
  });

  it("uses secure schemes when gateway TLS is enabled", () => {
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.1.100",
      tlsEnabled: true,
    });
    expect(links.httpUrl).toBe("https://192.168.1.100:18789/");
    expect(links.wsUrl).toBe("wss://192.168.1.100:18789");
  });

  it("falls back to loopback for invalid customBindHost", () => {
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.001.100",
    });
    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("uses tailnet IP for tailnet bind", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "tailnet",
    });
    expect(links.httpUrl).toBe("http://100.64.0.9:18789/");
    expect(links.wsUrl).toBe("ws://100.64.0.9:18789");
  });

  it("keeps loopback for auto even when tailnet is present", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "auto",
    });
    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("falls back to loopback for tailnet bind when interface discovery throws", () => {
    mocks.pickPrimaryTailnetIPv4.mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    const links = resolveControlUiLinks({
      port: 18789,
      bind: "tailnet",
    });

    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("falls back to loopback for LAN bind when interface discovery throws", () => {
    vi.spyOn(os, "networkInterfaces").mockImplementationOnce(() => {
      throw new Error("uv_interface_addresses failed");
    });

    const links = resolveControlUiLinks({
      port: 18789,
      bind: "lan",
    });

    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("uses route-aware advertised LAN host for display links", async () => {
    mocks.resolveAdvertisedLanHostCore.mockResolvedValueOnce("10.211.55.3");

    const links = await resolveAdvertisedControlUiLinks({
      port: 18789,
      bind: "lan",
    });

    expect(links.httpUrl).toBe("http://10.211.55.3:18789/");
    expect(links.wsUrl).toBe("ws://10.211.55.3:18789");
  });

  it("keeps co-located LAN probes on loopback", () => {
    const links = resolveLocalControlUiProbeLinks({
      port: 18789,
      bind: "lan",
    });

    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
    expect(mocks.resolveAdvertisedLanHostCore).not.toHaveBeenCalled();
  });
});

describe("normalizeGatewayTokenInput", () => {
  it("returns empty string for undefined or null", () => {
    expect(normalizeGatewayTokenInput(undefined)).toBe("");
    expect(normalizeGatewayTokenInput(null)).toBe("");
  });

  it("trims string input", () => {
    expect(normalizeGatewayTokenInput("  token  ")).toBe("token");
  });

  it("returns empty string for non-string input", () => {
    expect(normalizeGatewayTokenInput(123)).toBe("");
  });

  it('rejects literal string coercion artifacts ("undefined"/"null")', () => {
    expect(normalizeGatewayTokenInput("undefined")).toBe("");
    expect(normalizeGatewayTokenInput("null")).toBe("");
  });
});

describe("validateGatewayPasswordInput", () => {
  it("requires a non-empty password", () => {
    expect(validateGatewayPasswordInput("")).toBe("Required");
    expect(validateGatewayPasswordInput("   ")).toBe("Required");
  });

  it("rejects literal string coercion artifacts", () => {
    expect(validateGatewayPasswordInput("undefined")).toBe(
      'Cannot be the literal string "undefined" or "null"',
    );
    expect(validateGatewayPasswordInput("null")).toBe(
      'Cannot be the literal string "undefined" or "null"',
    );
  });

  it("accepts a normal password", () => {
    expect(validateGatewayPasswordInput(" secret ")).toBeUndefined();
  });
});
