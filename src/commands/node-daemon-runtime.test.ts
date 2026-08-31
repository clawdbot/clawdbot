import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runExec, access, stat } = vi.hoisted(() => ({
  runExec: vi.fn(),
  access: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("../process/exec.js", () => ({ runExec }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: { ...actual, access, stat, realpath: async (value: string) => value },
  };
});

import { buildNodeInstallPlan } from "./node-daemon-install-helpers.js";

const originalExecPath = process.execPath;
const originalArgv = process.argv;
beforeEach(() => {
  process.execPath = "/fixture/bun";
  process.argv = [process.execPath, path.resolve("/opt/openclaw/dist/index.js")];
  access.mockImplementation(async (value: string) => {
    if (
      value === "/usr/bin/node" ||
      value === process.argv[1] ||
      value === "/opt/openclaw-wrapper"
    ) {
      return;
    }
    throw new Error("ENOENT");
  });
  stat.mockResolvedValue({ isFile: () => true });
});
afterEach(() => {
  process.execPath = originalExecPath;
  process.argv = originalArgv;
  vi.resetAllMocks();
});

const install = (env: Record<string, string | undefined> = {}) =>
  buildNodeInstallPlan({
    env,
    host: "gateway.example",
    port: 18789,
    runtime: "node",
    devMode: false,
  });

describe.skipIf(process.platform === "win32")("node-host runtime install boundary", () => {
  it("accepts a Node 26 system runtime with safe embedded SQLite", async () => {
    runExec.mockResolvedValue({
      stdout: JSON.stringify({
        nodeVersion: "26.8.1",
        sqliteVersion: "3.53.4",
        nodeSharedSqlite: false,
      }),
      stderr: "",
    });
    const plan = await install();
    expect(plan.programArguments).toEqual([
      "/usr/bin/node",
      process.argv[1],
      "node",
      "run",
      "--host",
      "gateway.example",
      "--port",
      "18789",
    ]);
  });

  it("surfaces an exec failure through the install plan without Node upgrade advice", async () => {
    runExec.mockRejectedValue(new Error("spawn EACCES"));
    await expect(install()).rejects.toThrow(/Node runtime probe failed.*\/usr\/bin\/node.*EACCES/s);
  });

  it("uses OPENCLAW_WRAPPER even when native runtime probes cannot execute", async () => {
    runExec.mockRejectedValue(new Error("spawn EACCES"));
    const plan = await install({ OPENCLAW_WRAPPER: "/opt/openclaw-wrapper" });
    expect(plan.programArguments).toEqual([
      "/opt/openclaw-wrapper",
      "node",
      "run",
      "--host",
      "gateway.example",
      "--port",
      "18789",
    ]);
  });

  it("rejects a node-host wrapper without execute permission", async () => {
    access.mockRejectedValue(new Error("EACCES"));
    await expect(install({ OPENCLAW_WRAPPER: "/opt/openclaw-wrapper" })).rejects.toThrow(
      "OPENCLAW_WRAPPER must point to an executable file",
    );
  });
});
