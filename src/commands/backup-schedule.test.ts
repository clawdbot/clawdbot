import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/gateway-rpc.js")>();
  return { ...actual, callGatewayFromCli };
});

import { GIT_BACKUP_PUSH_CREDENTIAL_WARNING } from "./backup-git.js";
import { backupDisableCommand, backupEnableCommand } from "./backup-schedule.js";

const BACKUP_CRON_JOB_NAME = "openclaw-backup-scheduled";

describe("scheduled backups", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
  });

  it("adds one isolated command job with the selected Git backup argv", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.add") {
        return { created: true, job: { id: "backup-job" } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const runtime = createTestRuntime();
    await expect(
      backupEnableCommand(runtime, {
        repository: "/tmp/openclaw-backups",
        every: "6h",
        push: true,
        excludeSecrets: true,
      }),
    ).resolves.toEqual({ id: "backup-job", updated: false });
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({
        declarationKey: BACKUP_CRON_JOB_NAME,
        name: BACKUP_CRON_JOB_NAME,
        schedule: { kind: "every", everyMs: 21_600_000 },
        sessionTarget: "isolated",
        payload: {
          kind: "command",
          argv: [
            "openclaw",
            "backup",
            "git",
            "create",
            "--repository",
            "/tmp/openclaw-backups",
            "--all",
            "--push",
            "--exclude-secrets",
          ],
        },
      }),
    );
    expect(callGatewayFromCli).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("atomically converges an existing declaration and removes it idempotently", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      created: false,
      updated: true,
      job: { id: "existing" },
    });
    const runtime = createTestRuntime();
    await expect(
      backupEnableCommand(runtime, {
        repository: "/tmp/openclaw-backups",
        globalOnly: true,
      }),
    ).resolves.toEqual({ id: "existing", updated: true });
    expect(callGatewayFromCli).toHaveBeenCalledOnce();
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({
        declarationKey: BACKUP_CRON_JOB_NAME,
        payload: expect.objectContaining({ argv: expect.arrayContaining(["--global"]) }),
      }),
    );

    callGatewayFromCli.mockReset();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return { jobs: [{ id: "existing", name: BACKUP_CRON_JOB_NAME }] };
      }
      return { ok: true };
    });
    await expect(backupDisableCommand(runtime, {})).resolves.toEqual({ removed: true });
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.remove", {}, { id: "existing" });

    callGatewayFromCli.mockResolvedValueOnce({ jobs: [] });
    await expect(backupDisableCommand(runtime, {})).resolves.toEqual({ removed: false });
  });

  it("warns about credential material before provisioning a pushed schedule", async () => {
    const runtime = createTestRuntime();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      expect(method).toBe("cron.add");
      expect(runtime.error).toHaveBeenCalledWith(GIT_BACKUP_PUSH_CREDENTIAL_WARNING);
      return { created: true, job: { id: "backup-job" } };
    });

    await backupEnableCommand(runtime, {
      repository: "/tmp/openclaw-backups",
      push: true,
    });

    expect(callGatewayFromCli).toHaveBeenCalledOnce();
  });
});
