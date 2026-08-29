// Failed-update recovery must reuse the canonical start preflight.
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return { ...actual, isDefaultInstallIdentity: () => true };
});

const mocks = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  isEnabled: vi.fn(async () => true),
  readCommand: vi.fn(async () => ({
    programArguments: [process.execPath, path.resolve("missing-gateway-entrypoint.cjs"), "gateway"],
  })),
  readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
  findScope: vi.fn(async () => ({
    scope: "user" as const,
    unitName: "openclaw-gateway.service",
    unitPath: "/tmp/openclaw-gateway.service",
  })),
}));

vi.mock("./systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd.js")>()),
  startSystemdService: mocks.start,
  isSystemdServiceEnabled: mocks.isEnabled,
  readSystemdServiceExecStart: mocks.readCommand,
  readSystemdServiceRuntime: mocks.readRuntime,
  findInstalledSystemdGatewayScope: mocks.findScope,
}));

import { startGatewayServiceAfterFailedUpdate } from "./service.js";

afterEach(() => {
  vi.restoreAllMocks();
  mocks.start.mockReset().mockResolvedValue(undefined);
  mocks.isEnabled.mockReset().mockResolvedValue(true);
  mocks.readCommand.mockReset();
  mocks.readRuntime.mockReset().mockResolvedValue({ status: "stopped" });
  mocks.findScope.mockReset().mockResolvedValue({
    scope: "user",
    unitName: "openclaw-gateway.service",
    unitPath: "/tmp/openclaw-gateway.service",
  });
});

describe("startGatewayServiceAfterFailedUpdate", () => {
  it.each([
    {
      kind: "missing",
      program: path.resolve("missing-gateway-entrypoint.cjs"),
    },
    {
      kind: "temporary",
      program: path.join(os.tmpdir(), "openclaw-service-layout", "index.js"),
    },
  ])("refuses to start a $kind service program", async ({ kind, program }) => {
    mockProcessPlatform("linux");
    mocks.readCommand.mockResolvedValue({
      programArguments: [process.execPath, program, "gateway"],
    });

    await expect(
      startGatewayServiceAfterFailedUpdate({ env: {}, stdout: process.stdout }),
    ).rejects.toThrow(`service command points at a ${kind} path: ${program}`);
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
