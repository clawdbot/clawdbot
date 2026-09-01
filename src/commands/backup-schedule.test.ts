import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const gatewayRpc = vi.hoisted(() => ({
  call: vi.fn(),
  isImplicitLocalTarget: vi.fn(async () => true),
}));
const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/gateway-rpc.js")>();
  return {
    ...actual,
    callGatewayFromCli: gatewayRpc.call,
    isImplicitLocalGatewayTargetFromCli: gatewayRpc.isImplicitLocalTarget,
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, getRuntimeConfig: configMocks.getRuntimeConfig };
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
    gatewayRpc.call.mockReset();
    gatewayRpc.isImplicitLocalTarget.mockReset().mockResolvedValue(true);
    configMocks.getRuntimeConfig.mockReset().mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "ops-team" }] },
    });
  });

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("adds one isolated command job with the selected Git backup argv", async () => {
    gatewayRpc.call.mockImplementation(async (method: string) => {
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
    expect(gatewayRpc.call).toHaveBeenCalledWith(
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
    expect(gatewayRpc.call).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("schedules a configured agent using its normalized id", async () => {
    gatewayRpc.call.mockResolvedValue({ created: true, job: { id: "backup-job" } });
    const runtime = createTestRuntime();

    await backupEnableCommand(runtime, {
      repository: "/tmp/openclaw-backups",
      agent: "Ops Team",
    });

    const spec = gatewayRpc.call.mock.calls[0]?.[2] as { payload: { argv: string[] } };
    expect(spec.payload.argv).toContain("ops-team");
    expect(spec.payload.argv).not.toContain("--all");
  });

  it.each([
    [
      "unknown",
      "nope-agent",
      'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    ],
    ["empty", "", "--agent must not be blank"],
    ["whitespace-only", "   ", "--agent must not be blank"],
  ])("rejects an %s scheduled backup agent", async (_label, agent, message) => {
    const runtime = createTestRuntime();

    await expect(
      backupEnableCommand(runtime, {
        repository: "/tmp/openclaw-backups",
        agent,
      }),
    ).rejects.toThrow(message);

    expect(gatewayRpc.call).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("rejects an explicit blank interval %j before scheduling", async (every) => {
    const runtime = createTestRuntime();
    gatewayRpc.call.mockResolvedValue({ created: true, job: { id: "backup-job" } });

    await expect(
      backupEnableCommand(runtime, { repository: "/tmp/openclaw-backups", every }),
    ).rejects.toThrow("Invalid duration (empty)");
    expect(gatewayRpc.call).not.toHaveBeenCalled();
  });

  it("atomically converges an existing declaration and removes it idempotently", async () => {
    gatewayRpc.call.mockResolvedValueOnce({
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
    expect(gatewayRpc.call).toHaveBeenCalledOnce();
    expect(gatewayRpc.call).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({
        declarationKey: BACKUP_CRON_JOB_NAME,
        schedule: { kind: "every", everyMs: 86_400_000 },
        payload: expect.objectContaining({ argv: expect.arrayContaining(["--global"]) }),
      }),
    );

    gatewayRpc.call.mockReset();
    gatewayRpc.call.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs: [
            { id: "decoy", name: BACKUP_CRON_JOB_NAME },
            {
              id: "existing",
              name: "operator display name",
              declarationKey: BACKUP_CRON_JOB_NAME,
            },
          ],
        };
      }
      return { ok: true };
    });
    await expect(backupDisableCommand(runtime, {})).resolves.toEqual({ removed: true });
    expect(gatewayRpc.call).toHaveBeenCalledWith("cron.remove", {}, { id: "existing" });
    expect(gatewayRpc.call).not.toHaveBeenCalledWith("cron.remove", {}, { id: "decoy" });

    gatewayRpc.call.mockReset();
    gatewayRpc.call.mockResolvedValueOnce({
      jobs: [{ id: "decoy", name: BACKUP_CRON_JOB_NAME }],
    });
    await expect(backupDisableCommand(runtime, {})).resolves.toEqual({ removed: false });
  });

  it("redacts pushed schedules by default and warns only on explicit full fidelity", async () => {
    const runtime = createTestRuntime();
    gatewayRpc.call.mockResolvedValue({ created: true, job: { id: "backup-job" } });

    // Default pushed schedule: redacted, no credential warning.
    await backupEnableCommand(runtime, {
      repository: await pushReadyRepository(),
      push: true,
    });
    expect(gatewayRpc.call).toHaveBeenLastCalledWith(
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
    const lastSpec = gatewayRpc.call.mock.calls.at(-1)?.[2] as {
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
    expect(gatewayRpc.call).not.toHaveBeenCalled();
  });

  it("rejects scheduling through a non-local Gateway before touching local paths", async () => {
    gatewayRpc.isImplicitLocalTarget.mockResolvedValue(false);
    const runtime = createTestRuntime();
    const expected =
      "backup enable manages backups on the Gateway host and currently requires a local Gateway. Create the cron job manually with openclaw cron add for remote Gateways.";

    await expect(
      backupEnableCommand(runtime, {
        repository: "/path/that/does/not/exist",
        push: true,
        url: "ws://127.0.0.1:18789",
      }),
    ).rejects.toThrow(expected);
    await expect(
      backupDisableCommand(runtime, { url: "wss://gateway.example.invalid" }),
    ).rejects.toThrow(expected);
    expect(gatewayRpc.call).not.toHaveBeenCalled();
  });
});
