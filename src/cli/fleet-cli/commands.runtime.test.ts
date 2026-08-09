import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("../test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    create: vi.fn(),
    list: vi.fn(),
    status: vi.fn(),
    logs: vi.fn(),
    lifecycle: vi.fn(),
    upgrade: vi.fn(),
    remove: vi.fn(),
    backup: vi.fn(),
    restore: vi.fn(),
    doctor: vi.fn(),
  };
});

vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
vi.mock("../../fleet/service.runtime.js", () => ({
  createFleetService: () => ({
    create: mocks.create,
    list: mocks.list,
    status: mocks.status,
    logs: mocks.logs,
    lifecycle: mocks.lifecycle,
    upgrade: mocks.upgrade,
    remove: mocks.remove,
    backup: mocks.backup,
    restore: mocks.restore,
    doctor: mocks.doctor,
  }),
}));

import {
  runFleetCreateCommand,
  runFleetListCommand,
  runFleetLogsCommand,
  runFleetRemoveCommand,
  runFleetStatusCommand,
  runFleetBackupCommand,
  runFleetRestoreCommand,
  runFleetDoctorCommand,
} from "./commands.runtime.js";

describe("fleet command output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
    process.exitCode = undefined;
  });

  it("writes backup and restore JSON results", async () => {
    const backup = {
      tenant: "acme",
      archivePath: "/tmp/a.tgz",
      fileCount: 1,
      skippedSymlinks: 0,
      skippedSpecial: 0,
      note: "secret note",
    };
    const restore = {
      tenant: "acme",
      archivePath: "/tmp/a.tgz",
      token: "new-token",
      tokenNote: "Shown once.",
      started: false,
      url: "http://127.0.0.1:19100",
    };
    mocks.backup.mockResolvedValue(backup);
    mocks.restore.mockResolvedValue(restore);
    await runFleetBackupCommand({ tenant: "acme", json: true });
    await runFleetRestoreCommand({ tenant: "acme", from: "/tmp/a.tgz", force: false, json: true });
    expect(mocks.defaultRuntime.writeJson).toHaveBeenNthCalledWith(1, backup);
    expect(mocks.defaultRuntime.writeJson).toHaveBeenNthCalledWith(2, restore);
  });

  it("surfaces skipped symlink counts in human backup output", async () => {
    mocks.backup.mockResolvedValue({
      tenant: "acme",
      archivePath: "/tmp/a.tgz",
      fileCount: 3,
      skippedSymlinks: 2,
      skippedSpecial: 1,
      note: "secret note",
    });
    await runFleetBackupCommand({ tenant: "acme", json: false });
    expect(mocks.runtimeLogs.join("\n")).toContain("Skipped 2 symlink(s) and 1 special file(s)");
  });

  it("sets exitCode when doctor reports a failure", async () => {
    const reports = [
      {
        tenant: "acme",
        findings: [{ check: "port-binding", status: "fail", detail: "bad binding" }],
      },
    ];
    mocks.doctor.mockResolvedValue(reports);
    await runFleetDoctorCommand({ tenant: "acme", json: true });
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(reports);
    expect(process.exitCode).toBe(1);
  });

  it("writes the documented secret-bearing create JSON shape", async () => {
    const result = {
      tenant: "acme",
      containerName: "openclaw-cell-acme",
      port: 19_100,
      image: "ghcr.io/openclaw/openclaw:latest",
      runtime: "docker" as const,
      started: true,
      token: "gw-token",
      tokenNote: "Shown once. Store this Gateway token securely.",
      url: "http://127.0.0.1:19100",
      nextStep:
        "Open http://127.0.0.1:19100, then configure per-tenant channel accounts inside the cell.",
    };
    mocks.create.mockResolvedValue(result);

    await runFleetCreateCommand({ tenant: "acme", json: true });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(result);
  });

  it("prints the Gateway token exactly once in human create output", async () => {
    mocks.create.mockResolvedValue({
      tenant: "acme",
      containerName: "openclaw-cell-acme",
      port: 19_100,
      image: "image",
      runtime: "docker",
      started: true,
      token: "one-token",
      tokenNote: "Shown once. Store this Gateway token securely.",
      url: "http://127.0.0.1:19100",
      nextStep: "Open the cell.",
    });

    await runFleetCreateCommand({ tenant: "acme", json: false });

    expect(mocks.runtimeLogs.join("\n").match(/one-token/gu)).toHaveLength(1);
    expect(mocks.runtimeLogs.join("\n")).toContain("Shown once");
  });

  it("wraps deterministic list JSON in a cells object", async () => {
    const cells = [
      {
        tenant: "acme",
        state: "running",
        port: 19_100,
        image: "image",
        created: "2026-01-01T00:00:00.000Z",
      },
    ];
    mocks.list.mockResolvedValue(cells);

    await runFleetListCommand({ json: true });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({ cells });
  });

  it("delegates logs without adding formatted output", async () => {
    const options = { tenant: "acme", follow: true, tail: 100, since: "10m" };

    await runFleetLogsCommand(options);

    expect(mocks.logs).toHaveBeenCalledWith(options);
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it("writes status JSON and describes retained data on removal", async () => {
    const status = {
      tenant: "acme",
      containerName: "openclaw-cell-acme",
      runtime: "docker" as const,
      port: 19_100,
      image: "image",
      created: "2026-01-01T00:00:00.000Z",
      dataDir: "/tmp/acme",
      container: { state: "running", running: true, managed: true },
      health: {
        status: "ok" as const,
        url: "http://127.0.0.1:19100/healthz",
        httpStatus: 200,
      },
    };
    mocks.status.mockResolvedValue(status);
    mocks.remove.mockResolvedValue({ tenant: "acme", action: "rm", dataPurged: false });

    await runFleetStatusCommand({ tenant: "acme", json: true });
    await runFleetRemoveCommand({ tenant: "acme", force: false, purgeData: false });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(status);
    expect(mocks.runtimeLogs).toContain("Removed fleet cell acme; data retained.");
  });
});
