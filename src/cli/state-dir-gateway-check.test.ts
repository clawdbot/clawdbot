import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  probeGateway: vi.fn(),
  readServiceCommand: vi.fn(),
  resolveGatewayService: vi.fn(),
}));

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: mocks.callGateway,
}));
vi.mock("../gateway/probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/probe.js")>()),
  probeGateway: mocks.probeGateway,
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
}));

const { GatewayCredentialsRequiredError } =
  await vi.importActual<typeof import("../gateway/call.js")>("../gateway/call.js");
import { checkCliGatewayStateDir, compareCliGatewayStateDirs } from "./state-dir-gateway-check.js";

describe("state-dir-gateway-check", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;
  let cliStateDir: string;
  let cliConfigPath: string;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-state-dir-check-");
    cliStateDir = path.join(root, "cli");
    cliConfigPath = path.join(cliStateDir, "openclaw.json");
    await fs.mkdir(cliStateDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", cliStateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", cliConfigPath);
    mocks.callGateway.mockReset().mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.probeGateway.mockReset().mockResolvedValue({ ok: false });
    mocks.resolveGatewayService
      .mockReset()
      .mockReturnValue({ readCommand: mocks.readServiceCommand });
    mocks.readServiceCommand.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses canonical path identity for a missing config below a symlink", async () => {
    const gatewayStateDir = path.join(root, "gateway");
    const gatewayConfigPath = path.join(gatewayStateDir, "openclaw.json");
    await fs.mkdir(gatewayStateDir);
    const stateLink = path.join(root, "gateway-link");
    await fs.symlink(gatewayStateDir, stateLink);

    expect(
      compareCliGatewayStateDirs({
        cliStateDir: stateLink,
        cliConfigPath: path.join(stateLink, "openclaw.json"),
        gatewayStateDir,
        gatewayConfigPath,
        source: "live Gateway",
        mode: "refuse",
        command: "openclaw configure",
      }),
    ).toEqual({ kind: "allow" });
  });

  it("refuses an installed service mismatch from its recorded environment", async () => {
    const gatewayStateDir = path.join(root, "service");
    const gatewayConfigPath = path.join(gatewayStateDir, "openclaw.json");
    await fs.mkdir(gatewayStateDir);
    mocks.readServiceCommand.mockResolvedValue({
      programArguments: ["node", "gateway.js"],
      environment: {
        OPENCLAW_STATE_DIR: gatewayStateDir,
        OPENCLAW_CONFIG_PATH: gatewayConfigPath,
      },
    });

    await expect(
      checkCliGatewayStateDir({ command: "openclaw channels add", config: {} }),
    ).resolves.toMatchObject({ kind: "refuse" });
    const inspectedEnv = mocks.readServiceCommand.mock.calls[0]?.[0];
    expect(inspectedEnv).not.toHaveProperty("OPENCLAW_STATE_DIR");
    expect(inspectedEnv).not.toHaveProperty("OPENCLAW_CONFIG_PATH");
    expect(mocks.readServiceCommand.mock.calls[0]?.[1]).toMatchObject({ requireEffective: true });
  });

  it("allows a matching installed service without probing", async () => {
    mocks.readServiceCommand.mockResolvedValue({
      programArguments: ["node", "gateway.js"],
      environment: {
        OPENCLAW_STATE_DIR: cliStateDir,
        OPENCLAW_CONFIG_PATH: cliConfigPath,
      },
    });

    await expect(
      checkCliGatewayStateDir({ command: "openclaw models auth", config: {} }),
    ).resolves.toEqual({ kind: "allow" });
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "refuses an offline home mismatch when the service sets OPENCLAW_HOME: %s",
    async (serviceSetsHome) => {
      const canonicalRoot = await fs.realpath(root);
      const serviceHome = path.join(canonicalRoot, "service-home");
      const cliHome = path.join(canonicalRoot, "cli-home");
      const serviceRuntimeHome = serviceSetsHome ? path.join(serviceHome, "runtime") : serviceHome;
      await fs.mkdir(serviceHome);
      await fs.mkdir(cliHome);
      vi.stubEnv("HOME", serviceHome);
      vi.stubEnv("OPENCLAW_HOME", cliHome);
      vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", undefined);
      mocks.readServiceCommand.mockResolvedValue({
        programArguments: ["node", "gateway.js"],
        environment: {
          HOME: serviceHome,
          ...(serviceSetsHome ? { OPENCLAW_HOME: serviceRuntimeHome } : {}),
        },
      });

      await expect(
        checkCliGatewayStateDir({ command: "openclaw configure", config: {} }),
      ).resolves.toMatchObject({
        kind: "refuse",
        message: expect.stringContaining(path.join(serviceRuntimeHome, ".openclaw")),
      });
    },
  );

  it("refuses paths from an authenticated hello without service fallback", async () => {
    const gatewayStateDir = path.join(root, "gateway");
    const gatewayConfigPath = path.join(gatewayStateDir, "openclaw.json");
    await fs.mkdir(gatewayStateDir);
    mocks.callGateway.mockImplementation(
      async (options: {
        onHelloOk?: (hello: { snapshot: { stateDir?: string; configPath?: string } }) => void;
      }) => {
        options.onHelloOk?.({
          snapshot: { stateDir: gatewayStateDir, configPath: gatewayConfigPath },
        });
        return {};
      },
    );

    await expect(
      checkCliGatewayStateDir({ command: "openclaw channels add", config: {} }),
    ).resolves.toMatchObject({ kind: "refuse" });
    expect(mocks.readServiceCommand).not.toHaveBeenCalled();
  });

  it("warns only when a credential-blocked protocol probe reaches an unowned Gateway", async () => {
    mocks.callGateway.mockRejectedValue(
      new GatewayCredentialsRequiredError({ method: "status", configPath: cliConfigPath }),
    );
    mocks.probeGateway.mockResolvedValue({ ok: false, gatewayReached: true });

    await expect(
      checkCliGatewayStateDir({
        command: "openclaw models auth",
        config: { gateway: { auth: { mode: "token" } } },
      }),
    ).resolves.toMatchObject({ kind: "warn" });
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        includeDetails: false,
        suppressStoredDeviceAuth: true,
        timeoutMs: 3_000,
      }),
    );
  });

  it("allows an offline command and does not probe an ordinary transport failure", async () => {
    await expect(
      checkCliGatewayStateDir({ command: "openclaw configure", config: {} }),
    ).resolves.toEqual({ kind: "allow" });
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });

  it("warns for a remote Gateway without local inspection", async () => {
    await expect(
      checkCliGatewayStateDir({
        command: "openclaw configure",
        config: { gateway: { mode: "remote", remote: { url: "wss://gateway.example" } } },
      }),
    ).resolves.toMatchObject({ kind: "warn" });
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.readServiceCommand).not.toHaveBeenCalled();
  });

  it("warns when service inspection is unavailable without exposing its error", async () => {
    const error = new Error("private-service-inspection-canary");
    mocks.readServiceCommand.mockRejectedValue(error);

    const result = await checkCliGatewayStateDir({ command: "openclaw configure", config: {} });
    expect(result).toMatchObject({
      kind: "warn",
      message: expect.stringContaining("could not be verified"),
    });
    expect(JSON.stringify(result)).not.toContain("private-service-inspection-canary");
  });

  it("does not infer service paths from the CLI environment", async () => {
    mocks.readServiceCommand.mockResolvedValue({
      programArguments: ["node", "gateway.js"],
      environment: { PATH: "/synthetic/bin" },
    });

    await expect(
      checkCliGatewayStateDir({ command: "openclaw configure", config: {} }),
    ).resolves.toMatchObject({ kind: "warn" });
  });

  it("redacts credentials in remote target warnings", async () => {
    const result = await checkCliGatewayStateDir({
      command: "openclaw configure",
      config: {
        gateway: {
          mode: "remote",
          remote: {
            url: "wss://private-url-user:private-url-password@gateway.example?token=private-url-token",
          },
        },
      },
    });
    expect(result.kind).toBe("warn");
    expect(JSON.stringify(result)).not.toContain("private-url-");
  });
});
