import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { runProvisionSetup } from "./crabbox-worker-provision-commands.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    writeFile: vi.fn(actual.writeFile),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.resetAllMocks());

function createSetupFixture() {
  let authorized = true;
  const runCommand = vi.fn<CrabboxCommandRunner>().mockResolvedValue({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  });
  const stopLease = vi.fn(async () => {});
  const params = {
    binary: "crabbox",
    provider: "aws",
    deadline: Date.now() + 60_000,
    inspect: { id: "cbx_setup_authority", state: "running", tailscaleEnabled: false },
    profile: parseCrabboxProfile({ provider: "aws", ttl: "24h", idleTimeout: "60m" }),
    phase: "profile setup",
    setup: "install-worker",
    forwardedEnv: { WORKER_ARTIFACT_TOKEN: "fixture-artifact-value" },
    runCommand,
    stopLease,
    assertAuthorized: () => {
      if (!authorized) {
        throw new Error("worker turn authority changed");
      }
    },
  };
  return {
    params,
    revoke: () => {
      authorized = false;
    },
  };
}

describe("Crabbox setup profile authority", () => {
  it.each([true, false])(
    "rejects closed authority before profile effects (forwarded environment: %s)",
    async (forwardEnvironment) => {
      const { params, revoke } = createSetupFixture();
      revoke();
      const error = await runProvisionSetup({
        ...params,
        forwardedEnv: forwardEnvironment ? params.forwardedEnv : undefined,
      }).catch((cause: unknown) => cause);

      expect(error).toMatchObject({ message: "worker turn authority changed" });
      expect(WorkerProviderError.takeCleanupComplete(error)).toBe(true);
      expect(params.stopLease).toHaveBeenCalledOnce();
      expect(params.runCommand).not.toHaveBeenCalled();
      expect(fs.mkdtemp).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
    },
  );

  it.each(["directory creation", "profile write"] as const)(
    "rechecks authority after awaited %s and removes the temporary profile",
    async (boundary) => {
      const { params, revoke } = createSetupFixture();
      const directory = tempDirs.make("crabbox-setup-authority-");
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      vi.mocked(fs.mkdtemp).mockImplementationOnce(async () => {
        if (boundary === "directory creation") {
          entered.resolve();
          await resume.promise;
        }
        return directory;
      });
      if (boundary === "profile write") {
        const actual = await vi.importActual<typeof fs>("node:fs/promises");
        vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
          await actual.writeFile(...args);
          entered.resolve();
          await resume.promise;
        });
      }
      const pending = runProvisionSetup(params).catch((cause: unknown) => cause);
      try {
        await entered.promise;
        // Hold the real profile lifecycle across revocation, not an authorization call count.
        expect(params.runCommand).not.toHaveBeenCalled();
        if (boundary === "profile write") {
          expect(await fs.readFile(join(directory, "setup.env"), "utf8")).toContain(
            'WORKER_ARTIFACT_TOKEN="fixture-artifact-value"',
          );
        }
        revoke();
      } finally {
        resume.resolve();
        await pending;
      }

      expect(await pending).toMatchObject({ message: "worker turn authority changed" });
      expect(WorkerProviderError.takeCleanupComplete(await pending)).toBe(true);
      expect(params.runCommand).not.toHaveBeenCalled();
      expect(params.stopLease).toHaveBeenCalledOnce();
      await expect(fs.access(directory)).rejects.toMatchObject({ code: "ENOENT" });
      if (boundary === "directory creation") {
        expect(fs.writeFile).not.toHaveBeenCalled();
      }
    },
  );

  it("rechecks authority after the setup command settles", async () => {
    const { params, revoke } = createSetupFixture();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    params.runCommand.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return {
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
    const pending = runProvisionSetup(params).catch((cause: unknown) => cause);
    await entered.promise;
    revoke();
    resume.resolve();

    const error = await pending;
    expect(error).toMatchObject({ message: "worker turn authority changed" });
    expect(WorkerProviderError.takeCleanupComplete(error)).toBe(true);
    expect(params.stopLease).toHaveBeenCalledOnce();
  });
});
