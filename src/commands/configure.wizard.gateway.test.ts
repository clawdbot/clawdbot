// Configure wizard Gateway tests cover run-mode probes, auth routing, and cancellation.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import {
  createWizardTestRuntime as createRuntime,
  queueWizardTestPrompts as queueWizardPrompts,
  runConfigureWizard,
  setupWizardTestDefaults,
  setupBaseWizardTestState as setupBaseWizardState,
  wizardTestMocks as mocks,
} from "./configure.wizard.test-support.js";

const { maybeInstallDaemon, formatHealthCheckFailure } = mocks;

const requireRecord = createRequireRecord("object", "expected-label");

function mockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  label: string,
  callIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex}`);
  }
  return call[0];
}

function requireWriteConfig(callIndex = 0) {
  return requireRecord(
    mockCallArg(mocks.writeConfigFile, "writeConfigFile", callIndex),
    "written config",
  );
}

function getGateway(config: Record<string, unknown>) {
  return requireRecord(config.gateway, "gateway config");
}

describe("runConfigureWizard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupWizardTestDefaults();
  });

  it("runs selected sections in canonical order and commits their combined config once", async () => {
    setupBaseWizardState();
    queueWizardPrompts({ select: ["local", "configure"], confirm: [] });
    const events: string[] = [];
    mocks.promptAuthConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("model");
      return cfg;
    });
    mocks.promptGatewayConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("gateway");
      return { config: cfg, port: 18789 };
    });
    mocks.setupChannels.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("channels");
      return cfg;
    });
    mocks.writeConfigFile.mockImplementationOnce(async () => {
      events.push("commit");
    });

    await runConfigureWizard(
      { command: "configure", sections: ["channels", "gateway", "model"] },
      createRuntime(),
    );

    expect(events).toEqual(["model", "gateway", "channels", "commit"]);
    expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
  });

  it("commits every interactive section before running the next section", async () => {
    setupBaseWizardState();
    queueWizardPrompts({
      select: ["local", "model", "gateway", "channels", "configure", "__continue"],
      confirm: [],
    });
    const events: string[] = [];
    mocks.promptAuthConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("model");
      return cfg;
    });
    mocks.promptGatewayConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("gateway");
      return { config: cfg, port: 18789 };
    });
    mocks.setupChannels.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("channels");
      return cfg;
    });
    for (let index = 0; index < 3; index += 1) {
      mocks.writeConfigFile.mockImplementationOnce(async () => {
        events.push("commit");
      });
    }

    await runConfigureWizard({ command: "configure" }, createRuntime());

    expect(events).toEqual(["model", "commit", "gateway", "commit", "channels", "commit"]);
    expect(mocks.writeConfigFile).toHaveBeenCalledTimes(3);
  });

  it("commits selected gateway config before installing its configured daemon port", async () => {
    setupBaseWizardState();
    queueWizardPrompts({ select: ["local"], confirm: [] });
    const events: string[] = [];
    mocks.promptGatewayConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => {
      events.push("gateway");
      return { config: cfg, port: 18991 };
    });
    mocks.writeConfigFile.mockImplementationOnce(async () => {
      events.push("commit");
    });
    vi.mocked(maybeInstallDaemon).mockImplementationOnce(async () => {
      events.push("daemon");
      return "succeeded";
    });

    await runConfigureWizard(
      { command: "configure", sections: ["daemon", "gateway"] },
      createRuntime(),
    );

    expect(events).toEqual(["gateway", "commit", "daemon"]);
    expect(maybeInstallDaemon).toHaveBeenCalledWith(expect.objectContaining({ port: 18991 }));
    expect(mocks.clackText).not.toHaveBeenCalled();
  });

  it("keeps remote password health when the configured token ref is unresolved", async () => {
    const remotePassword = "remote-password"; // pragma: allowlist secret
    const remoteConfig: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example.test",
          token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
          password: remotePassword,
        },
      },
      secrets: { providers: { default: { source: "env" } } },
    };
    setupBaseWizardState(remoteConfig);
    queueWizardPrompts({ select: ["remote"], confirm: [] });
    mocks.promptRemoteGatewayConfig.mockResolvedValueOnce(remoteConfig);

    await runConfigureWizard({ command: "configure", sections: ["health"] }, createRuntime());

    expect(mocks.healthCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        config: remoteConfig,
        token: undefined,
        password: remotePassword,
        ignoreEnvUrlOverride: true,
      }),
      expect.anything(),
    );
  });

  it.each([
    ["unreachable gateway", false, new Error("health request failed")],
    ["health request failure", true, new Error("health request failed")],
    ["trapped health CLI exit", true, new ExitError(1)],
  ])("reports failed remote health checks (%s)", async (_reason, probeOk, error) => {
    setupBaseWizardState();
    queueWizardPrompts({ select: ["remote"], confirm: [] });
    mocks.waitForGatewayReachable.mockResolvedValueOnce({ ok: probeOk });
    mocks.healthCommand.mockRejectedValueOnce(error);

    await runConfigureWizard({ command: "configure", sections: ["health"] }, createRuntime());

    expect(mocks.clackOutro).toHaveBeenCalledWith(expect.stringContaining("health check failed"));
    if (error instanceof ExitError) {
      // healthCommand already printed its diagnostic before the trapped exit.
      expect(formatHealthCheckFailure).not.toHaveBeenCalled();
    }
  });

  it("skips remote health when a configured SecretRef is unresolved", async () => {
    const unresolvedConfig: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example.test",
          token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
        },
      },
      secrets: { providers: { default: { source: "env" } } },
    };
    setupBaseWizardState(unresolvedConfig);
    queueWizardPrompts({ select: ["remote"], confirm: [] });
    mocks.promptRemoteGatewayConfig.mockResolvedValueOnce(unresolvedConfig);
    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "ambient-password" }, async () => {
      await runConfigureWizard({ command: "configure", sections: ["health"] }, createRuntime());
    });

    const authNote = mocks.note.mock.calls.find(([, title]) => title === "Gateway auth")?.[0];
    expect(authNote).toContain("Health check skipped");
    expect(mocks.healthCommand).not.toHaveBeenCalled();
    expect(mocks.clackOutro).toHaveBeenCalledWith(
      "Remote gateway configured; health check skipped.",
    );
  });

  it("persists gateway.mode=local when only the run mode is selected", async () => {
    setupBaseWizardState();
    queueWizardPrompts({
      select: ["local", "__continue"],
      confirm: [false],
    });

    await runConfigureWizard({ command: "configure" }, createRuntime());

    expect(getGateway(requireWriteConfig()).mode).toBe("local");
    const replaceParams = requireRecord(
      mockCallArg(mocks.replaceConfigFile, "replaceConfigFile"),
      "replace config params",
    );
    const writeOptions = requireRecord(replaceParams.writeOptions, "write options");
    expect(Object.keys(writeOptions).toSorted()).toEqual([
      "assertConfigPathForWrite",
      "expectedConfigPath",
      "ownedConfigPathForWrite",
    ]);
  });

  it("persists edge auth returned by the shared remote Gateway prompt", async () => {
    const remoteConfig: OpenClawConfig = {
      gateway: {
        mode: "remote",
        remote: {
          url: "wss://gateway.example.test",
          edgeAuth: { "X-Edge-Auth": "test-secret" },
        },
      },
    };
    setupBaseWizardState(remoteConfig);
    queueWizardPrompts({ select: ["remote"], confirm: [] });
    mocks.promptRemoteGatewayConfig.mockResolvedValueOnce(remoteConfig);

    await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());

    const remote = requireRecord(getGateway(requireWriteConfig()).remote, "remote config");
    expect(remote.edgeAuth).toEqual({
      "X-Edge-Auth": "test-secret",
    });
  });

  it("keeps startup gateway hint probes bounded", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        remote: {
          url: "wss://gateway.example.test",
          token: "token",
          edgeAuth: { "X-Edge-Auth": "test-secret" },
        },
      },
    });
    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "env-password" }, async () => {
      await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());
    });

    const probeRequests = mocks.probeGatewayReachable.mock.calls.map(([request]) =>
      requireRecord(request, "probe request"),
    );
    const localProbe = probeRequests.find((request) => request.url === "ws://127.0.0.1:18789");
    const remoteProbe = probeRequests.find(
      (request) => request.url === "wss://gateway.example.test",
    );
    expect(localProbe?.timeoutMs).toBe(300);
    expect(remoteProbe).toEqual({
      url: "wss://gateway.example.test",
      config: expect.objectContaining({
        gateway: expect.objectContaining({
          remote: expect.objectContaining({
            edgeAuth: { "X-Edge-Auth": "test-secret" },
          }),
        }),
      }),
      token: "token",
      timeoutMs: 300,
    });
  });

  it("ignores blank gateway env credentials when probing the local gateway", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        auth: { token: "configured-token", password: "configured-password" },
      },
    });
    process.env.OPENCLAW_GATEWAY_TOKEN = "";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "";
    try {
      await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());
    } finally {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    }

    const probeRequests = mocks.probeGatewayReachable.mock.calls.map(([request]) =>
      requireRecord(request, "probe request"),
    );
    const localProbe = probeRequests.find((request) => request.url === "ws://127.0.0.1:18789");
    expect(localProbe?.token).toBe("configured-token");
    expect(localProbe?.password).toBe("configured-password");
  });

  it("uses resolved SecretRef auth for local gateway and health probes", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "WIZARD_GATEWAY_TOKEN" },
        },
      },
    });
    queueWizardPrompts({ select: ["local"], confirm: [] });

    await withEnvAsync(
      { OPENCLAW_GATEWAY_TOKEN: "ambient-token", WIZARD_GATEWAY_TOKEN: "configured-token" },
      () =>
        runConfigureWizard(
          { command: "configure", sections: ["gateway", "health"] },
          createRuntime(),
        ),
    );

    expect(mocks.probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ token: "configured-token", timeoutMs: 300 }),
    );
    expect(mocks.waitForGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ token: "configured-token" }),
    );
    expect(mocks.healthCommand).toHaveBeenCalledWith(
      expect.objectContaining({ token: "configured-token" }),
      expect.anything(),
    );
  });

  it("visibly skips local probes when a configured SecretRef is unavailable", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "MISSING_WIZARD_PASSWORD" },
        },
      },
    });
    queueWizardPrompts({ select: ["local"], confirm: [] });

    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "ambient-password" }, () =>
      runConfigureWizard(
        { command: "configure", sections: ["gateway", "health"] },
        createRuntime(),
      ),
    );

    expect(mocks.probeGatewayReachable).not.toHaveBeenCalled();
    expect(mocks.waitForGatewayReachable).not.toHaveBeenCalled();
    expect(mocks.healthCommand).not.toHaveBeenCalled();
    expect(mocks.clackSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({
            hint: expect.stringContaining("auth unavailable; probe skipped"),
          }),
        ]),
      }),
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway: auth unavailable (probe skipped)"),
      "Control UI",
    );
  });

  it("never retries an old password after the newly configured SecretRef fails", async () => {
    setupBaseWizardState({
      gateway: { mode: "local", auth: { mode: "password", password: "previous-password" } },
    });
    queueWizardPrompts({ select: ["local"], confirm: [] });
    mocks.promptGatewayConfig.mockImplementationOnce(async (cfg: OpenClawConfig) => ({
      config: {
        ...cfg,
        gateway: {
          ...cfg.gateway,
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "MISSING_WIZARD_PASSWORD" },
          },
        },
      },
      port: 18789,
    }));

    await withEnvAsync({ OPENCLAW_GATEWAY_PASSWORD: "ambient-password" }, () =>
      runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime()),
    );

    expect(mocks.probeGatewayReachable).toHaveBeenCalledOnce();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway: auth unavailable (probe skipped)"),
      "Control UI",
    );
  });

  it("uses the resolved configured port for the local gateway startup hint", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        port: 18991,
      },
    });
    mocks.resolveGatewayPort.mockReturnValue(18991);
    mocks.probeGatewayReachable
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValue({ ok: false });
    mocks.clackSelect.mockResolvedValue("local");

    await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());

    expect(mocks.probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18991", timeoutMs: 300 }),
    );
    expect(mocks.clackSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Where will the Gateway run?",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "local",
            hint: "Gateway reachable (ws://127.0.0.1:18991)",
          }),
        ]),
      }),
    );
  });

  it("advertises LAN Control UI links while probing the local gateway", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "token" },
      },
    });
    mocks.resolveAdvertisedControlUiLinks.mockResolvedValueOnce({
      httpUrl: "http://10.211.55.3:18789/",
      wsUrl: "ws://10.211.55.3:18789",
    });
    mocks.resolveLocalControlUiProbeLinks.mockReturnValueOnce({
      httpUrl: "http://127.0.0.1:18789/",
      wsUrl: "ws://127.0.0.1:18789",
    });
    await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());

    expect(mocks.resolveAdvertisedControlUiLinks).toHaveBeenCalledWith(
      expect.objectContaining({ bind: "lan", port: 18789 }),
    );
    expect(mocks.probeGatewayReachable).toHaveBeenCalledWith(
      expect.objectContaining({ url: "ws://127.0.0.1:18789" }),
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Web UI: http://10.211.55.3:18789/"),
      "Control UI",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway WS: ws://10.211.55.3:18789"),
      "Control UI",
    );
  });

  it("shows static Windows Firewall guidance for LAN Gateway links without inspection", async () => {
    setupBaseWizardState({
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "token" },
      },
    });

    await runConfigureWizard({ command: "configure", sections: ["gateway"] }, createRuntime());

    expect(mocks.inspectWindowsGatewayFirewall).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("Windows firewall: if another device cannot connect to the LAN URL"),
      "Control UI",
    );
  });

  it("exits with code 1 when configure wizard is cancelled", async () => {
    const runtime = createRuntime();
    setupBaseWizardState();
    mocks.clackSelect.mockRejectedValueOnce(new WizardCancelledError());

    await runConfigureWizard({ command: "configure" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("uses nonzero exit semantics for cancellation at the first direct Clack prompt", async () => {
    const runtime = createRuntime();
    setupBaseWizardState();
    mocks.guardCancel.mockImplementationOnce(
      (_value: unknown, promptRuntime: RuntimeEnv, exitCode?: number) => {
        promptRuntime.exit(exitCode ?? 0);
        throw new Error("direct prompt cancelled");
      },
    );

    await expect(runConfigureWizard({ command: "configure" }, runtime)).rejects.toThrow(
      "direct prompt cancelled",
    );

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("does not gate model-only configure behind Gateway run-mode selection", async () => {
    setupBaseWizardState();

    await runConfigureWizard({ command: "configure", sections: ["model"] }, createRuntime());

    expect(mocks.promptAuthConfig).toHaveBeenCalledOnce();
    expect(mocks.clackSelect).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Where will the Gateway run?" }),
    );
    expect(mocks.probeGatewayReachable).not.toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 300 }),
    );
    expect(mocks.resolveControlUiLinks).not.toHaveBeenCalled();
    expect(requireWriteConfig().gateway).toBeUndefined();
  });

  it("runs model-only configure for existing remote Gateway configs", async () => {
    setupBaseWizardState({
      gateway: { mode: "remote", remote: { url: "wss://gateway.example.test" } },
    });

    await runConfigureWizard({ command: "configure", sections: ["model"] }, createRuntime());

    expect(mocks.promptAuthConfig).toHaveBeenCalledOnce();
    expect(mocks.promptRemoteGatewayConfig).not.toHaveBeenCalled();
    expect(getGateway(requireWriteConfig()).mode).toBe("remote");
    expect(mocks.resolveControlUiLinks).not.toHaveBeenCalled();
    expect(mocks.probeGatewayReachable).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith(
      [
        "Remote Gateway:",
        "wss://gateway.example.test",
        "Docs: https://docs.openclaw.ai/gateway/remote",
      ].join("\n"),
      "Gateway",
    );
  });
});
