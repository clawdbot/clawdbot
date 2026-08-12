import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/gateway-rpc.js")>();
  return { ...actual, callGatewayFromCli };
});

import {
  BACKUP_CRON_JOB_NAME,
  backupDisableCommand,
  backupEnableCommand,
} from "./backup-schedule.js";

describe("scheduled backups", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
  });

  it("adds one isolated command job with the selected Git backup argv", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return { jobs: [] };
      }
      if (method === "cron.add") {
        return { id: "backup-job" };
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
  });

  it("patches an existing named job and removes it idempotently", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return { jobs: [{ id: "existing", name: BACKUP_CRON_JOB_NAME }] };
      }
      return { ok: true };
    });
    const runtime = createTestRuntime();
    await expect(
      backupEnableCommand(runtime, {
        repository: "/tmp/openclaw-backups",
        globalOnly: true,
      }),
    ).resolves.toEqual({ id: "existing", updated: true });
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "cron.update",
      expect.anything(),
      expect.objectContaining({
        id: "existing",
        patch: expect.objectContaining({
          payload: expect.objectContaining({ argv: expect.arrayContaining(["--global"]) }),
        }),
      }),
    );
    await expect(backupDisableCommand(runtime, {})).resolves.toEqual({ removed: true });
    expect(callGatewayFromCli).toHaveBeenCalledWith("cron.remove", {}, { id: "existing" });

    callGatewayFromCli.mockResolvedValueOnce({ jobs: [] });
    await expect(backupDisableCommand(runtime, {})).resolves.toEqual({ removed: false });
  });
});
