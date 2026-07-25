// Covers conservative stale recovery for retired MCP OAuth lock sidecars.
import fs from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isDefinitelyStaleLegacyMcpOAuthLock } from "./state-migrations.mcp-oauth-lock-stale.js";
import { withRootBoundedLegacyFileLock } from "./state-migrations.mcp-oauth-lock.js";

function payload(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    pid: 123,
    createdAt: "2026-07-16T00:00:00.000Z",
    starttime: 456,
    ...overrides,
  })}\n`;
}

describe("legacy MCP OAuth lock recovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

  it("classifies only old locks with a definitely dead or reused owner", () => {
    const nowMs = Date.parse("2026-07-16T00:02:00.000Z");
    expect(
      isDefinitelyStaleLegacyMcpOAuthLock({
        raw: payload(),
        nowMs,
        isPidDefinitelyDead: () => true,
        getProcessStartTime: () => null,
      }),
    ).toBe(true);
    expect(
      isDefinitelyStaleLegacyMcpOAuthLock({
        raw: payload(),
        nowMs,
        isPidDefinitelyDead: () => false,
        getProcessStartTime: () => 789,
      }),
    ).toBe(true);
  });

  it("fails closed for live, young, and malformed owner evidence", () => {
    const nowMs = Date.parse("2026-07-16T00:02:00.000Z");
    const liveOwner = {
      nowMs,
      isPidDefinitelyDead: () => false,
      getProcessStartTime: () => 456,
    };
    expect(isDefinitelyStaleLegacyMcpOAuthLock({ raw: payload(), ...liveOwner })).toBe(false);
    expect(
      isDefinitelyStaleLegacyMcpOAuthLock({
        raw: payload({ createdAt: "2026-07-16T00:01:30.000Z" }),
        ...liveOwner,
      }),
    ).toBe(false);
    expect(
      isDefinitelyStaleLegacyMcpOAuthLock({
        raw: payload({ createdAt: "invalid" }),
        ...liveOwner,
      }),
    ).toBe(false);
    expect(
      isDefinitelyStaleLegacyMcpOAuthLock({
        raw: payload({ starttime: "456" }),
        ...liveOwner,
      }),
    ).toBe(false);
    expect(
      isDefinitelyStaleLegacyMcpOAuthLock({
        raw: "not json",
        ...liveOwner,
      }),
    ).toBe(false);
  });

  it("reports a stale sidecar without unlinking a replacement-prone path", async () => {
    const stateDir = tempDirs.make("openclaw-mcp-oauth-stale-lock-");
    const targetRelativePath = path.join("mcp-oauth", "server-0123456789abcdef.json");
    const lockPath = path.join(stateDir, `${targetRelativePath}.lock`);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const raw = payload({
      pid: 2 ** 30,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      starttime: 1,
    });
    await fs.writeFile(lockPath, raw);
    const stateRoot = await root(stateDir, {
      hardlinks: "reject",
      symlinks: "reject",
    });
    let entered = false;

    await expect(
      withRootBoundedLegacyFileLock({ stateRoot, targetRelativePath }, async () => {
        entered = true;
      }),
    ).rejects.toMatchObject({ code: "file_lock_stale" });

    expect(entered).toBe(false);
    expect(await fs.readFile(lockPath, "utf8")).toBe(raw);
  });
});
