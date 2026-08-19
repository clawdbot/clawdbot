import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HealthCheck, OpenClawConfig } from "openclaw/plugin-sdk/health";
import { describe, expect, it, vi } from "vitest";
import { CODEX_APP_SERVER_VERSION } from "./app-server/version.js";
import {
  CODEX_MANAGED_APP_SERVER_CHECK_ID,
  registerCodexManagedAppServerDoctorChecks,
} from "./doctor.js";

function config(appServer: Record<string, unknown> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-sol" },
        models: {
          "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
        },
      },
    },
    plugins: {
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: {
              args: [
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "model_context_window=1000000",
                "-c",
                "model_auto_compact_token_limit=700000",
                "-c",
                "model_auto_compact_token_limit_scope=total",
              ],
              ...appServer,
            },
          },
        },
      },
    },
  };
}

function context(cfg: OpenClawConfig) {
  return {
    mode: "lint" as const,
    runtime: {} as never,
    cfg,
    env: {} as NodeJS.ProcessEnv,
  };
}

function managedDeps(version = CODEX_APP_SERVER_VERSION) {
  const resolveNativeCommand = vi.fn(
    (_command: string): string | undefined => "/candidate/plugin/codex-native",
  );
  return {
    resolveStartOptions: vi.fn(async (start) => ({
      ...start,
      command:
        start.managedCommandOrder === "desktop-first"
          ? "/Applications/ChatGPT.app/Contents/Resources/codex"
          : "/candidate/plugin/codex",
      commandSource: "resolved-managed" as const,
    })),
    isDesktopCommand: vi.fn((command: string) => command.startsWith("/Applications/")),
    resolveNativeCommand,
    runVersionCommand: vi.fn(async () => ({ stdout: `codex-cli ${version}\n`, stderr: "" })),
  };
}

function createCheck(deps: ReturnType<typeof managedDeps>) {
  let check: HealthCheck | undefined;
  registerCodexManagedAppServerDoctorChecks(
    {
      pluginRoot: "/candidate/plugin",
      registerHealthCheck(value) {
        check = value;
      },
    },
    deps,
  );
  if (!check) {
    throw new Error("Codex managed health check was not registered");
  }
  return check;
}

describe("managed Codex doctor check", () => {
  it("accepts the exact pinned native binary without changing explicit long-context config", async () => {
    const cfg = config();
    const before = structuredClone(cfg);
    const deps = managedDeps();
    const check = createCheck(deps);

    await expect(check.detect(context(cfg))).resolves.toEqual([]);
    expect(deps.runVersionCommand).toHaveBeenCalledWith("/candidate/plugin/codex-native");
    expect(cfg).toEqual(before);
  });

  it("reports the exact expected and detected versions", async () => {
    const deps = managedDeps("0.146.0");
    const check = createCheck(deps);

    await expect(check.detect(context(config()))).resolves.toEqual([
      expect.objectContaining({
        checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
        severity: "error",
        path: "/candidate/plugin/codex-native",
        message: `Managed Codex app-server version mismatch: expected ${CODEX_APP_SERVER_VERSION}, detected 0.146.0.`,
      }),
    ]);
  });

  it("reports a missing managed launcher before execution", async () => {
    const deps = managedDeps();
    deps.resolveStartOptions.mockRejectedValueOnce(new Error("managed launcher missing"));
    const check = createCheck(deps);

    await expect(check.detect(context(config()))).resolves.toEqual([
      expect.objectContaining({
        checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
        message: "Managed Codex app-server could not be resolved: managed launcher missing",
      }),
    ]);
    expect(deps.runVersionCommand).not.toHaveBeenCalled();
  });

  it("reports a launcher whose platform-native artifact is absent", async () => {
    const deps = managedDeps();
    deps.resolveNativeCommand.mockReturnValueOnce(undefined);
    const check = createCheck(deps);

    await expect(check.detect(context(config()))).resolves.toEqual([
      expect.objectContaining({
        checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
        path: "/candidate/plugin/codex",
        message: "Managed Codex app-server resolved a launcher without a native artifact.",
      }),
    ]);
    expect(deps.runVersionCommand).not.toHaveBeenCalled();
  });

  it("reports a bounded version command failure", async () => {
    const deps = managedDeps();
    deps.runVersionCommand.mockRejectedValueOnce(new Error("timed out after 5000 ms"));
    const check = createCheck(deps);

    await expect(check.detect(context(config()))).resolves.toEqual([
      expect.objectContaining({
        checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
        path: "/candidate/plugin/codex-native",
        message: "Managed Codex app-server version check failed: timed out after 5000 ms",
        requirement: `Codex ${CODEX_APP_SERVER_VERSION} must report its version within 5000 ms`,
      }),
    ]);
  });

  it.each([
    ["custom command", { command: "/operator/codex" }],
    ["websocket transport", { transport: "websocket", url: "ws://127.0.0.1:4500" }],
    ["unix transport", { transport: "unix", url: "unix:///tmp/codex.sock", homeScope: "user" }],
  ])("does not probe a %s", async (_label, appServer) => {
    const deps = managedDeps();
    const check = createCheck(deps);

    await expect(check.detect(context(config(appServer)))).resolves.toEqual([]);
    expect(deps.resolveStartOptions).not.toHaveBeenCalled();
    expect(deps.runVersionCommand).not.toHaveBeenCalled();
  });

  it("does not enforce the package pin on a selected desktop-owned command", async () => {
    const deps = managedDeps("0.146.0");
    const check = createCheck(deps);

    await expect(check.detect(context(config({ homeScope: "user" })))).resolves.toEqual([]);
    expect(deps.resolveStartOptions).toHaveBeenCalledWith(
      expect.objectContaining({ managedCommandOrder: "desktop-first" }),
      { pluginRoot: "/candidate/plugin" },
    );
    expect(deps.resolveNativeCommand).not.toHaveBeenCalled();
    expect(deps.runVersionCommand).not.toHaveBeenCalled();
  });

  it("uses persisted per-agent Computer Use state before selecting the managed command", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-agent-"));
    try {
      await fs.mkdir(path.join(agentDir, "codex-home"));
      await fs.writeFile(
        path.join(agentDir, "codex-home", "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );
      const cfg = config();
      cfg.agents = {
        ...cfg.agents,
        list: [{ id: "main", agentDir }],
      };
      const deps = managedDeps("0.146.0");
      const check = createCheck(deps);

      await expect(check.detect(context(cfg))).resolves.toEqual([]);
      expect(deps.resolveStartOptions).toHaveBeenCalledWith(
        expect.objectContaining({ managedCommandOrder: "desktop-first" }),
        { pluginRoot: "/candidate/plugin" },
      );
      expect(deps.resolveNativeCommand).not.toHaveBeenCalled();
      expect(deps.runVersionCommand).not.toHaveBeenCalled();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("still validates the package when any configured agent can select it", async () => {
    const desktopAgentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-doctor-desktop-agent-"),
    );
    const packageAgentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-doctor-package-agent-"),
    );
    try {
      await fs.mkdir(path.join(desktopAgentDir, "codex-home"));
      await fs.writeFile(
        path.join(desktopAgentDir, "codex-home", "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );
      const cfg = config();
      cfg.agents = {
        ...cfg.agents,
        list: [
          { id: "desktop", agentDir: desktopAgentDir },
          { id: "package", agentDir: packageAgentDir },
        ],
      };
      const deps = managedDeps("0.146.0");
      const check = createCheck(deps);

      await expect(check.detect(context(cfg))).resolves.toEqual([
        expect.objectContaining({
          checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
          message: `Managed Codex app-server version mismatch: expected ${CODEX_APP_SERVER_VERSION}, detected 0.146.0.`,
        }),
      ]);
      expect(deps.resolveStartOptions).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ managedCommandOrder: "desktop-first" }),
        { pluginRoot: "/candidate/plugin" },
      );
      expect(deps.resolveStartOptions).toHaveBeenNthCalledWith(
        2,
        expect.not.objectContaining({ managedCommandOrder: expect.anything() }),
        { pluginRoot: "/candidate/plugin" },
      );
      expect(deps.runVersionCommand).toHaveBeenCalledWith("/candidate/plugin/codex-native");
    } finally {
      await Promise.all(
        [desktopAgentDir, packageAgentDir].map((agentDir) =>
          fs.rm(agentDir, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("ignores managed commands for agents whose effective runtime is not Codex", async () => {
    const desktopAgentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-codex-doctor-desktop-agent-"),
    );
    try {
      await fs.mkdir(path.join(desktopAgentDir, "codex-home"));
      await fs.writeFile(
        path.join(desktopAgentDir, "codex-home", "config.toml"),
        '[plugins."computer-use@openai-bundled"]\nenabled = true\n',
      );
      const cfg = config();
      cfg.agents = {
        ...cfg.agents,
        list: [
          { id: "desktop", agentDir: desktopAgentDir },
          {
            id: "openclaw",
            model: "anthropic/claude-opus-4-7",
            models: {
              "anthropic/claude-opus-4-7": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      };
      const deps = managedDeps("0.146.0");
      const check = createCheck(deps);

      await expect(check.detect(context(cfg))).resolves.toEqual([]);
      expect(deps.resolveStartOptions).toHaveBeenCalledTimes(1);
      expect(deps.runVersionCommand).not.toHaveBeenCalled();
    } finally {
      await fs.rm(desktopAgentDir, { recursive: true, force: true });
    }
  });

  it("still validates a package fallback selected after desktop-first resolution", async () => {
    const deps = managedDeps("0.146.0");
    deps.resolveStartOptions.mockImplementationOnce(async (start) => ({
      ...start,
      command: "/candidate/plugin/codex",
      commandSource: "resolved-managed" as const,
    }));
    const check = createCheck(deps);

    await expect(check.detect(context(config({ homeScope: "user" })))).resolves.toEqual([
      expect.objectContaining({
        checkId: CODEX_MANAGED_APP_SERVER_CHECK_ID,
        message: `Managed Codex app-server version mismatch: expected ${CODEX_APP_SERVER_VERSION}, detected 0.146.0.`,
      }),
    ]);
    expect(deps.runVersionCommand).toHaveBeenCalledWith("/candidate/plugin/codex-native");
  });
});
