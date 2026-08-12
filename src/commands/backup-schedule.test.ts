import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const callGatewayFromCli = vi.hoisted(() => vi.fn());

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/gateway-rpc.js")>();
  return { ...actual, callGatewayFromCli };
});

import { GIT_BACKUP_PUSH_CREDENTIAL_WARNING } from "./backup-git.js";
import { backupDisableCommand, backupEnableCommand } from "./backup-schedule.js";

const BACKUP_CRON_JOB_NAME = "openclaw-backup-scheduled";

const roots: string[] = [];

// enable --push preflights an origin remote, so push fixtures need a real repo.
async function pushReadyRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-schedule-test-"));
  roots.push(root);
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "remote", "add", "origin", "git@example.invalid:backups.git"], {
    stdio: "ignore",
  });
  return root;
}

describe("scheduled backups", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
  });

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("adds one isolated command job with the selected Git backup argv", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "cron.add") {
        return { created: true, job: { id: "backup-job" } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const runtime = createTestRuntime();
    const repository = await pushReadyRepository();
    await expect(
      backupEnableCommand(runtime, {
        repository,
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
            repository,
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

  it("redacts pushed schedules by default and warns only on explicit full fidelity", async () => {
    const runtime = createTestRuntime();
    callGatewayFromCli.mockResolvedValue({ created: true, job: { id: "backup-job" } });

    // Default pushed schedule: redacted, no credential warning.
    await backupEnableCommand(runtime, {
      repository: await pushReadyRepository(),
      push: true,
    });
    expect(callGatewayFromCli).toHaveBeenLastCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({ argv: expect.arrayContaining(["--exclude-secrets"]) }),
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();

    // Explicit --include-secrets keeps full fidelity and warns.
    await backupEnableCommand(runtime, {
      repository: await pushReadyRepository(),
      push: true,
      includeSecrets: true,
    });
    const lastSpec = callGatewayFromCli.mock.calls.at(-1)?.[2] as {
      payload: { argv: string[] };
    };
    expect(lastSpec.payload.argv).not.toContain("--exclude-secrets");
    expect(runtime.error).toHaveBeenCalledWith(GIT_BACKUP_PUSH_CREDENTIAL_WARNING);

    await expect(
      backupEnableCommand(runtime, {
        repository: await pushReadyRepository(),
        push: true,
        includeSecrets: true,
        excludeSecrets: true,
      }),
    ).rejects.toThrow(/not both/);
  });

  it("refuses a pushed schedule when the repository has no origin remote", async () => {
    const runtime = createTestRuntime();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-schedule-test-"));
    roots.push(root);
    execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
    await expect(backupEnableCommand(runtime, { repository: root, push: true })).rejects.toThrow(
      /--push requires an origin remote/,
    );
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });
});
