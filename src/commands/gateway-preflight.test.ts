import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  ensureCliPluginRegistryLoaded: vi.fn(),
  collectGatewayStartupPreflight: vi.fn(),
  withOpenClawStateDatabaseInspectionSnapshots: vi.fn(
    async (run: () => Promise<unknown>) => await run(),
  ),
  unresolvedDirectories: [] as string[],
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../cli/plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: mocks.ensureCliPluginRegistryLoaded,
}));

vi.mock("../infra/startup-preflight.js", () => ({
  collectGatewayStartupPreflight: mocks.collectGatewayStartupPreflight,
}));

vi.mock("../infra/path-case.js", () => ({
  withReadOnlyPathCaseProbe: async (run: () => unknown) => ({
    value: await run(),
    unresolvedDirectories: mocks.unresolvedDirectories,
  }),
}));

vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  withOpenClawStateDatabaseInspectionSnapshots: mocks.withOpenClawStateDatabaseInspectionSnapshots,
}));

import { gatewayPreflightCommand } from "./gateway-preflight.js";

async function runJsonPreflight() {
  let result: unknown;
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn((value: unknown) => {
      result = value;
    }),
    exit: vi.fn(),
  };
  await gatewayPreflightCommand({ json: true }, runtime);
  return { result, runtime };
}

describe("gateway startup preflight command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unresolvedDirectories = [];
    delete process.env.JITI_FS_CACHE;
  });

  it("uses an unobserved config read and the memory embedding provider scope", async () => {
    const config = { memory: { search: { provider: "local", fallback: "none" } } };
    const sourceConfig = structuredClone(config);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config,
      sourceConfig,
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 1,
      blockers: [],
      errors: [],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toEqual({
      protocol: "openclaw.gateway.startup-preflight",
      protocolVersion: 1,
      ok: true,
      status: "ready",
      checksRun: 1,
      blockers: [],
      errors: [],
    });
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
    expect(mocks.ensureCliPluginRegistryLoaded).toHaveBeenCalledWith({
      scope: "memory-embedding-providers",
      routeLogsToStderr: true,
      config,
      activationSourceConfig: sourceConfig,
    });
    expect(mocks.collectGatewayStartupPreflight).toHaveBeenCalledWith({
      config,
      env: process.env,
    });
    expect(mocks.withOpenClawStateDatabaseInspectionSnapshots).toHaveBeenCalledTimes(1);
    expect(process.env.JITI_FS_CACHE).toBeUndefined();
  });

  it("disables plugin transform cache writes only for the evaluation", async () => {
    process.env.JITI_FS_CACHE = "true";
    mocks.readConfigFileSnapshot.mockImplementation(async () => {
      expect(process.env.JITI_FS_CACHE).toBe("false");
      return {
        valid: true,
        config: {},
        sourceConfig: {},
      };
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 0,
      blockers: [],
      errors: [],
    });

    const { result } = await runJsonPreflight();

    expect(result).toMatchObject({
      status: "ready",
    });
    expect(process.env.JITI_FS_CACHE).toBe("true");
  });

  it("returns indeterminate instead of writing when path case cannot be inspected", async () => {
    mocks.unresolvedDirectories = ["/protected/state"];
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {},
      sourceConfig: {},
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue({
      checksRun: 1,
      blockers: [],
      errors: [],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "indeterminate",
      checksRun: 1,
      blockers: [],
      errors: [
        {
          id: "filesystem/path-case",
          code: "filesystem-inspection-indeterminate",
          message: expect.stringContaining("/protected/state"),
        },
      ],
    });
    expect(runtime.exit).toHaveBeenCalledWith(2, { resetStream: process.stderr });
  });

  it("returns exit 2 for invalid config without loading plugins", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: false,
      issues: [{ path: ["memory", "search", "provider"], message: "Invalid provider" }],
    });

    const { result, runtime } = await runJsonPreflight();

    expect(result).toMatchObject({
      ok: false,
      status: "indeterminate",
      checksRun: 0,
      blockers: [],
      errors: [{ id: "config/validation", code: "invalid-config" }],
    });
    expect(runtime.exit).toHaveBeenCalledWith(2, { resetStream: process.stderr });
    expect(mocks.ensureCliPluginRegistryLoaded).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "blocked" as const,
      evaluation: {
        checksRun: 1,
        blockers: [{ id: "memory/local", code: "missing", message: "missing" }],
        errors: [],
      },
      exitCode: 1,
    },
    {
      status: "indeterminate" as const,
      evaluation: {
        checksRun: 1,
        blockers: [],
        errors: [{ id: "memory/local", code: "unsupported", message: "unsupported" }],
      },
      exitCode: 2,
    },
  ])("writes one JSON result and exits for $status", async ({ evaluation, exitCode }) => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {},
      sourceConfig: {},
    });
    mocks.collectGatewayStartupPreflight.mockResolvedValue(evaluation);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    };

    await gatewayPreflightCommand({ json: true }, runtime);

    expect(runtime.writeJson).toHaveBeenCalledTimes(1);
    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        checksRun: 1,
        blockers: evaluation.blockers,
        errors: evaluation.errors,
      }),
      2,
    );
    expect(runtime.exit).toHaveBeenCalledWith(exitCode, { resetStream: process.stderr });
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
