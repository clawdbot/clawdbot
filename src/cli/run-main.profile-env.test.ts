// Run-main profile env tests cover profile environment handling in the CLI entrypoint.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";

const startup = vi.hoisted(() => ({
  readConfig: vi.fn(async () => ({ proxy: { selected: "synthetic" } })),
  startProxy: vi.fn(async () => null),
  ensurePath: vi.fn(),
  ensureDispatcher: vi.fn(),
  route: vi.fn(async () => true),
}));

vi.mock("../config/io.js", () => ({
  readSourceConfigBestEffort: startup.readConfig,
  readBestEffortConfig: startup.readConfig,
}));

vi.mock("../infra/net/proxy/proxy-lifecycle.js", () => ({
  startProxy: startup.startProxy,
}));

vi.mock("../infra/net/proxy-env.js", () => ({
  hasEnvHttpProxyAgentConfigured: () => true,
}));

vi.mock("../infra/net/undici-global-dispatcher.js", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: startup.ensureDispatcher,
}));

const fileState = vi.hoisted(() => ({
  hasCliDotEnv: false,
}));

const dotenvState = vi.hoisted(() => {
  const state = {
    profileAtDotenvLoad: undefined as string | undefined,
    containerAtDotenvLoad: undefined as string | undefined,
  };
  return {
    state,
    loadDotEnv: vi.fn(() => {
      state.profileAtDotenvLoad = process.env.OPENCLAW_PROFILE;
      state.containerAtDotenvLoad = process.env.OPENCLAW_CONTAINER;
    }),
  };
});

const maybeRunCliInContainerMock = vi.hoisted(() =>
  vi.fn((argv: string[]) => ({ handled: false, argv })),
);

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  type ExistsSyncPath = Parameters<typeof actual.existsSync>[0];
  return {
    ...actual,
    existsSync: vi.fn((target: ExistsSyncPath) => {
      if (typeof target === "string" && target.endsWith(".env")) {
        return fileState.hasCliDotEnv;
      }
      return actual.existsSync(target);
    }),
  };
});

vi.mock("./dotenv.js", () => ({
  loadCliDotEnv: dotenvState.loadDotEnv,
}));

vi.mock("../infra/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/env.js")>()),
  normalizeEnv: vi.fn(),
}));

vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: vi.fn(),
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: startup.ensurePath,
}));

vi.mock("./route.js", () => ({
  tryRouteCli: startup.route,
}));

vi.mock("./windows-argv.js", () => ({
  normalizeWindowsArgv: (argv: string[]) => argv,
}));

vi.mock("./container-target.js", async () => {
  const actual =
    await vi.importActual<typeof import("./container-target.js")>("./container-target.js");
  return {
    ...actual,
    maybeRunCliInContainer: maybeRunCliInContainerMock,
  };
});

import { runCli } from "./run-main.js";

describe("runCli environment and passive startup", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_PROFILE",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_CONTAINER",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    deleteTestEnvValue("OPENCLAW_PROFILE");
    deleteTestEnvValue("OPENCLAW_STATE_DIR");
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_CONTAINER");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PORT");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
    dotenvState.state.profileAtDotenvLoad = undefined;
    dotenvState.state.containerAtDotenvLoad = undefined;
    dotenvState.loadDotEnv.mockClear();
    maybeRunCliInContainerMock.mockClear();
    fileState.hasCliDotEnv = false;
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it.each([
    ...["--channel", "--tag", "--timeout"].flatMap((flag) =>
      ["beta", "", "--", "--no-restart"].flatMap((value) => [
        [flag, value, "cleanup"],
        [`${flag}=${value}`, "cleanup"],
      ]),
    ),
    ["--no-restart", "cleanup"],
    ["--accept-capabilities", "cleanup"],
    ["--", "cleanup"],
    ["--channel", "beta", "--", "cleanup"],
    ["--dry-run", "--json", "--yes", "cleanup"],
    ["cleanup", "--dry-run", "--json", "--yes"],
    ["cleanup", "--channel", "beta"],
    ["cleanup", "--version"],
  ])("keeps cleanup passive before dispatch: %j", async (...args) => {
    const argv = ["node", "openclaw", "update", ...args];
    await runCli(argv);

    expect(startup.route).toHaveBeenCalledWith(argv);
    expect({
      configReads: startup.readConfig.mock.calls.length,
      proxyStarts: startup.startProxy.mock.calls.length,
      pathEnsures: startup.ensurePath.mock.calls.length,
      dispatcherEnsures: startup.ensureDispatcher.mock.calls.length,
    }).toEqual({ configReads: 0, proxyStarts: 0, pathEnsures: 0, dispatcherEnsures: 0 });
  });

  it.each(["--channel", "--tag", "--timeout"])(
    "retains update startup when cleanup is the value of %s",
    async (flag) => {
      await runCli(["node", "openclaw", "update", flag, "cleanup"]);
      expect(startup.readConfig).toHaveBeenCalledOnce();
      expect(startup.startProxy).toHaveBeenCalledWith({ selected: "synthetic" });
      expect(startup.ensurePath).toHaveBeenCalledOnce();
      expect(startup.ensureDispatcher).toHaveBeenCalledOnce();
    },
  );

  it("applies --profile before dotenv loading", async () => {
    fileState.hasCliDotEnv = true;
    await runCli(["node", "openclaw", "--profile", "rawdog", "status"]);

    expect(dotenvState.loadDotEnv).toHaveBeenCalledOnce();
    expect(dotenvState.state.profileAtDotenvLoad).toBe("rawdog");
    expect(process.env.OPENCLAW_PROFILE).toBe("rawdog");
  });

  it("rejects --container combined with --profile", async () => {
    await expect(
      runCli(["node", "openclaw", "--container", "demo", "--profile", "rawdog", "status"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");

    expect(dotenvState.loadDotEnv).not.toHaveBeenCalled();
    expect(process.env.OPENCLAW_PROFILE).toBe("rawdog");
  });

  it("rejects --container combined with interleaved --profile", async () => {
    await expect(
      runCli(["node", "openclaw", "status", "--container", "demo", "--profile", "rawdog"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");
  });

  it("rejects --container combined with interleaved --dev", async () => {
    await expect(
      runCli(["node", "openclaw", "status", "--container", "demo", "--dev"]),
    ).rejects.toThrow("--container cannot be combined with --profile/--dev");
  });

  it("does not let dotenv change container target resolution", async () => {
    fileState.hasCliDotEnv = true;
    dotenvState.loadDotEnv.mockImplementationOnce(() => {
      process.env.OPENCLAW_CONTAINER = "demo";
      dotenvState.state.profileAtDotenvLoad = process.env.OPENCLAW_PROFILE;
      dotenvState.state.containerAtDotenvLoad = process.env.OPENCLAW_CONTAINER;
    });

    await runCli(["node", "openclaw", "status"]);

    expect(dotenvState.loadDotEnv).toHaveBeenCalledOnce();
    expect(process.env.OPENCLAW_CONTAINER).toBe("demo");
    expect(dotenvState.state.containerAtDotenvLoad).toBe("demo");
    expect(maybeRunCliInContainerMock).toHaveBeenCalledWith(["node", "openclaw", "status"]);
    expect(maybeRunCliInContainerMock).toHaveReturnedWith({
      handled: false,
      argv: ["node", "openclaw", "status"],
    });
  });

  it("allows container mode when OPENCLAW_PROFILE is already set in env", async () => {
    setTestEnvValue("OPENCLAW_PROFILE", "work");

    await expect(
      runCli(["node", "openclaw", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["OPENCLAW_GATEWAY_PORT", "19001"],
    ["OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789"],
    ["OPENCLAW_GATEWAY_TOKEN", "demo-token"],
    ["OPENCLAW_GATEWAY_PASSWORD", "demo-password"],
  ])("allows container mode when %s is set in env", async (key, value) => {
    setTestEnvValue(key, value);

    await expect(
      runCli(["node", "openclaw", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });

  it("allows container mode when only OPENCLAW_STATE_DIR is set in env", async () => {
    setTestEnvValue("OPENCLAW_STATE_DIR", "/tmp/openclaw-host-state");

    await expect(
      runCli(["node", "openclaw", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });

  it("allows container mode when only OPENCLAW_CONFIG_PATH is set in env", async () => {
    setTestEnvValue("OPENCLAW_CONFIG_PATH", "/tmp/openclaw-host-state/openclaw.json");

    await expect(
      runCli(["node", "openclaw", "--container", "demo", "status"]),
    ).resolves.toBeUndefined();
  });
});
