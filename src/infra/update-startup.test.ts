import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateCheckResult } from "./update-check.js";

vi.mock("./moltbot-root.js", () => ({
  resolveMoltbotPackageRoot: vi.fn(),
}));

vi.mock("./update-check.js", async () => {
  const actual = await vi.importActual<typeof import("./update-check.js")>("./update-check.js");
  return {
    ...actual,
    checkUpdateStatus: vi.fn(),
    fetchNpmTagVersion: vi.fn(),
    resolveNpmChannelTag: vi.fn(),
  };
});

vi.mock("../version.js", () => ({
  VERSION: "1.0.0",
}));

describe("update-startup", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-17T10:00:00Z"));
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-update-check-"));
    process.env.CLAWDBOT_STATE_DIR = tempDir;
    delete process.env.VITEST;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("logs update hint for npm installs when newer tag exists", async () => {
    const { resolveMoltbotPackageRoot } = await import("./moltbot-root.js");
    const { checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js");
    const { runGatewayUpdateCheck } = await import("./update-startup.js");

    vi.mocked(resolveMoltbotPackageRoot).mockResolvedValue("/opt/moltbot");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/moltbot",
      installKind: "package",
      packageManager: "npm",
    } satisfies UpdateCheckResult);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "2.0.0",
    });

    const log = { info: vi.fn() };
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("update available (latest): v2.0.0"),
    );

    const statePath = path.join(tempDir, "update-check.json");
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as { lastNotifiedVersion?: string };
    expect(parsed.lastNotifiedVersion).toBe("2.0.0");
  });

  it("uses latest when beta tag is older than release", async () => {
    const { resolveMoltbotPackageRoot } = await import("./moltbot-root.js");
    const { checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js");
    const { runGatewayUpdateCheck } = await import("./update-startup.js");

    vi.mocked(resolveMoltbotPackageRoot).mockResolvedValue("/opt/moltbot");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/moltbot",
      installKind: "package",
      packageManager: "npm",
    } satisfies UpdateCheckResult);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "2.0.0",
    });

    const log = { info: vi.fn() };
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "beta" } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("update available (latest): v2.0.0"),
    );

    const statePath = path.join(tempDir, "update-check.json");
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as { lastNotifiedTag?: string };
    expect(parsed.lastNotifiedTag).toBe("latest");
  });

  it("skips update check when disabled in config", async () => {
    const { runGatewayUpdateCheck } = await import("./update-startup.js");
    const log = { info: vi.fn() };

    await runGatewayUpdateCheck({
      cfg: { update: { checkOnStart: false } },
      log,
      isNixMode: false,
      allowInTests: true,
    });

    expect(log.info).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(tempDir, "update-check.json"))).rejects.toThrow();
  });
});
