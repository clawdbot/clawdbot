import { access, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { startPhoneProofServer } from "./login-gate-e2e.test-support.ts";
import { phoneProofCleanup } from "./phone-stale-build-recovery.test-support.ts";

const startProductionControlUiE2eServer = vi.hoisted(() => vi.fn());

vi.mock("../test-helpers/control-ui-e2e.ts", () => ({
  installMockGateway: vi.fn(),
  startProductionControlUiE2eServer,
}));

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function requireBuildDir(buildDir: string | undefined): string {
  if (!buildDir) {
    throw new Error("production server did not receive a build directory");
  }
  return buildDir;
}

describe("phone stale-build proof cleanup", () => {
  it("removes the allocated build directory when production startup fails", async () => {
    const startupError = new Error("production startup failed");
    let buildDir: string | undefined;
    startProductionControlUiE2eServer.mockImplementationOnce(async (outDir: string) => {
      buildDir = outDir;
      throw startupError;
    });

    try {
      await expect(startPhoneProofServer("phone-proof-build")).rejects.toBe(startupError);
      await expectPathMissing(requireBuildDir(buildDir));
    } finally {
      if (buildDir) {
        await rm(buildDir, { force: true, recursive: true });
      }
    }
  });

  it("closes the production server and removes its build directory", async () => {
    const closeServer = vi.fn(async () => undefined);
    let buildDir: string | undefined;
    startProductionControlUiE2eServer.mockImplementationOnce(async (outDir: string) => {
      buildDir = outDir;
      return { baseUrl: "http://127.0.0.1:3210/", close: closeServer };
    });

    const server = await startPhoneProofServer("phone-proof-build");
    expect(server.baseUrl).toBe("http://127.0.0.1:3210/");
    const allocatedBuildDir = requireBuildDir(buildDir);
    await expect(access(allocatedBuildDir)).resolves.toBeUndefined();

    await server.close();

    expect(closeServer).toHaveBeenCalledTimes(1);
    await expectPathMissing(allocatedBuildDir);
  });

  it("closes an allocated server when later setup fails", async () => {
    const closeServer = vi.fn(async () => undefined);

    await expect(
      (async () => {
        await using serverCleanup = phoneProofCleanup(closeServer);
        void serverCleanup;
        throw new Error("context allocation failed");
      })(),
    ).rejects.toThrow("context allocation failed");

    expect(closeServer).toHaveBeenCalledTimes(1);
  });

  it("closes browser and server resources after evidence writing fails", async () => {
    const cleanupOrder: string[] = [];
    const closeServer = vi.fn(async () => void cleanupOrder.push("server"));
    const closeBrowser = vi.fn(async () => void cleanupOrder.push("browser"));

    await expect(
      (async () => {
        await using serverCleanup = phoneProofCleanup(closeServer);
        await using browserCleanup = phoneProofCleanup(closeBrowser);
        void serverCleanup;
        void browserCleanup;
        throw new Error("evidence write failed");
      })(),
    ).rejects.toThrow("evidence write failed");

    expect(cleanupOrder).toEqual(["browser", "server"]);
  });
});
