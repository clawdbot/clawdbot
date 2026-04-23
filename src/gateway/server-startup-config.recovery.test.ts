import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { buildTestConfigSnapshot } from "./test-helpers.config-snapshots.js";

vi.mock("../config/config.js", () => ({
  applyConfigOverrides: vi.fn((config: OpenClawConfig) => config),
  isNixMode: false,
  readConfigFileSnapshot: vi.fn(),
  recoverConfigFromLastKnownGood: vi.fn(),
  recoverConfigFromJsonRootSuffix: vi.fn(),
  writeConfigFile: vi.fn(),
}));

vi.mock("./config-recovery-notice.js", () => ({
  enqueueConfigRecoveryNotice: vi.fn(),
}));

let loadGatewayStartupConfigSnapshot: typeof import("./server-startup-config.js").loadGatewayStartupConfigSnapshot;
let configIo: typeof import("../config/config.js");
let recoveryNotice: typeof import("./config-recovery-notice.js");

const configPath = "/tmp/openclaw-startup-recovery.json";
const validConfig = {
  gateway: {
    mode: "local",
  },
} as OpenClawConfig;

function buildSnapshot(params: {
  valid: boolean;
  raw: string;
  config?: OpenClawConfig;
}): ConfigFileSnapshot {
  return buildTestConfigSnapshot({
    path: configPath,
    exists: true,
    raw: params.raw,
    parsed: params.config ?? null,
    valid: params.valid,
    config: params.config ?? ({} as OpenClawConfig),
    issues: params.valid ? [] : [{ path: "gateway.mode", message: "Expected 'local' or 'remote'" }],
    legacyIssues: [],
  });
}

describe("gateway startup config recovery", () => {
  beforeAll(async () => {
    ({ loadGatewayStartupConfigSnapshot } = await import("./server-startup-config.js"));
    configIo = await import("../config/config.js");
    recoveryNotice = await import("./config-recovery-notice.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores last-known-good config before startup validation", async () => {
    const invalidSnapshot = buildSnapshot({ valid: false, raw: "{ invalid json" });
    const recoveredSnapshot = buildSnapshot({
      valid: true,
      raw: `${JSON.stringify(validConfig)}\n`,
      config: validConfig,
    });
    vi.mocked(configIo.readConfigFileSnapshot)
      .mockResolvedValueOnce(invalidSnapshot)
      .mockResolvedValueOnce(recoveredSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(true);
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log,
      }),
    ).resolves.toEqual({
      snapshot: recoveredSnapshot,
      wroteConfig: true,
    });

    expect(configIo.recoverConfigFromLastKnownGood).toHaveBeenCalledWith({
      snapshot: invalidSnapshot,
      reason: "startup-invalid-config",
    });
    expect(log.warn).toHaveBeenCalledWith(
      `gateway: invalid config was restored from last-known-good backup: ${configPath}`,
    );
    expect(recoveryNotice.enqueueConfigRecoveryNotice).toHaveBeenCalledWith({
      cfg: recoveredSnapshot.config,
      phase: "startup",
      reason: "startup-invalid-config",
      configPath,
    });
  });

  it("keeps startup validation loud when last-known-good recovery is unavailable", async () => {
    const invalidSnapshot = buildSnapshot({ valid: false, raw: "{ invalid json" });
    vi.mocked(configIo.readConfigFileSnapshot).mockResolvedValueOnce(invalidSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(false);
    vi.mocked(configIo.recoverConfigFromJsonRootSuffix).mockResolvedValueOnce(false);

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log: { info: vi.fn(), warn: vi.fn() },
      }),
    ).rejects.toThrow(
      `Invalid config at ${configPath}.\ngateway.mode: Expected 'local' or 'remote'\nRun "openclaw doctor --fix" to repair, then retry.`,
    );

    expect(recoveryNotice.enqueueConfigRecoveryNotice).not.toHaveBeenCalled();
  });

  it("strips a valid JSON suffix when last-known-good recovery is unavailable", async () => {
    const invalidSnapshot = buildSnapshot({
      valid: false,
      raw: `Found and updated: False\n${JSON.stringify(validConfig)}\n`,
    });
    const repairedSnapshot = buildSnapshot({
      valid: true,
      raw: `${JSON.stringify(validConfig)}\n`,
      config: validConfig,
    });
    vi.mocked(configIo.readConfigFileSnapshot)
      .mockResolvedValueOnce(invalidSnapshot)
      .mockResolvedValueOnce(repairedSnapshot);
    vi.mocked(configIo.recoverConfigFromLastKnownGood).mockResolvedValueOnce(false);
    vi.mocked(configIo.recoverConfigFromJsonRootSuffix).mockResolvedValueOnce(true);
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(
      loadGatewayStartupConfigSnapshot({
        minimalTestGateway: true,
        log,
      }),
    ).resolves.toEqual({
      snapshot: repairedSnapshot,
      wroteConfig: true,
    });

    expect(configIo.recoverConfigFromJsonRootSuffix).toHaveBeenCalledWith(invalidSnapshot);
    expect(log.warn).toHaveBeenCalledWith(
      `gateway: invalid config was repaired by stripping a non-JSON prefix: ${configPath}`,
    );
  });
});
