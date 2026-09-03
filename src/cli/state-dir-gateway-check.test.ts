import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  probeGateway: vi.fn(),
  readGatewayServiceState: vi.fn(),
  resolveGatewayService: vi.fn(() => ({})),
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
  readGatewayServiceState: mocks.readGatewayServiceState,
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
    mocks.readGatewayServiceState.mockReset().mockResolvedValue({
      installed: false,
      env: {},
    });
    mocks.resolveGatewayService.mockClear();
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

  it.each([true, false, undefined])(
    "refuses an installed service mismatch when running is %s",
    async (running) => {
      const gatewayStateDir = path.join(root, "service");
      const gatewayConfigPath = path.join(gatewayStateDir, "openclaw.json");
      await fs.mkdir(gatewayStateDir);
      mocks.readGatewayServiceState.mockImplementation(
        async (_service: unknown, options: { env: NodeJS.ProcessEnv }) => ({
          installed: true,
          running,
          env: {
            ...options.env,
            OPENCLAW_STATE_DIR: gatewayStateDir,
            OPENCLAW_CONFIG_PATH: gatewayConfigPath,
          },
        }),
      );

      await expect(
        checkCliGatewayStateDir({ command: "openclaw channels add", config: {} }),
      ).resolves.toMatchObject({ kind: "refuse" });
      const inspectedEnv = mocks.readGatewayServiceState.mock.calls[0]?.[1]?.env;
      expect(inspectedEnv).not.toHaveProperty("OPENCLAW_STATE_DIR");
      expect(inspectedEnv).not.toHaveProperty("OPENCLAW_CONFIG_PATH");
    },
  );

  it("allows a matching installed service without probing", async () => {
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      running: false,
      env: {
        OPENCLAW_STATE_DIR: cliStateDir,
        OPENCLAW_CONFIG_PATH: cliConfigPath,
      },
    });

    await expect(
      checkCliGatewayStateDir({ command: "openclaw models auth", config: {} }),
    ).resolves.toEqual({ kind: "allow" });
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });

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
    expect(mocks.readGatewayServiceState).not.toHaveBeenCalled();
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
    expect(mocks.readGatewayServiceState).not.toHaveBeenCalled();
  });
});
