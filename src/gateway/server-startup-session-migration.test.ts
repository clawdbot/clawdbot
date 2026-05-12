import { describe, expect, it, vi } from "vitest";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeCfg() {
  return { agents: { defaults: {} }, session: {} } as Parameters<
    typeof runStartupSessionMigration
  >[0]["cfg"];
}

describe("runStartupSessionMigration", () => {
  it("logs changes when orphaned keys are canonicalized", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockResolvedValue({
      changes: ["Canonicalized 2 orphaned session key(s) in /tmp/store.json"],
      warnings: [],
    });
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate },
    });
    expect(migrate).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.info.mock.calls.at(0)?.[0]).toContain("canonicalized orphaned session keys");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs warnings from migration", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockResolvedValue({
      changes: [],
      warnings: ["Could not read /bad/path: ENOENT"],
    });
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate },
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls.at(0)?.[0]).toContain("session key migration warnings");
  });

  it("silently continues when no changes needed", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockResolvedValue({ changes: [], warnings: [] });
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate },
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("catches and logs migration errors without throwing", async () => {
    const log = makeLog();
    const migrate = vi.fn().mockRejectedValue(new Error("disk full"));
    await runStartupSessionMigration({
      cfg: makeCfg(),
      log,
      deps: { migrateOrphanedSessionKeys: migrate },
    });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls.at(0)?.[0]).toContain("migration failed during startup");
    expect(log.warn.mock.calls.at(0)?.[0]).toContain("disk full");
  });
});
