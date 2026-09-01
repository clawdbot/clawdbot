// Proves the doctor migration itself -- not just the exported cleanup
// helper in isolation -- actually reaches and removes aged orphan reindex
// shadow files left beside the *legacy* (pre-per-agent-database) memory
// index sidecar path. A direct call to cleanupAgedMemoryReindexTempFiles
// with a hand-built legacy path proves the matcher pattern works; it does
// not prove anything in a real upgraded install ever calls it with that
// path, since the current production reindex caller only ever resolves the
// *current* per-agent database path (see the comment on
// sweepLegacyMemorySidecarReindexOrphans in doctor-memory-sidecar.ts).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memorySidecarStateMigration } from "./doctor-memory-sidecar.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.access(targetPath)).rejects.toThrow("ENOENT");
}

describe("Memory Core legacy sidecar migration reindex-orphan reachability", () => {
  let stateDir = "";

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-sidecar-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("reclaims aged pre-8b7269d1978 .tmp- orphan shadows beside the legacy sidecar while active ones survive", async () => {
    const legacyDir = path.join(stateDir, "memory");
    await fs.mkdir(legacyDir, { recursive: true });
    // The default agent id (normalizeAgentId(undefined) === "main") at the
    // exact legacy default path collectLegacyMemorySidecarSources still
    // scans: stateDir/memory/<agentId>.sqlite.
    const legacyPath = path.join(legacyDir, "main.sqlite");
    // A zero-byte placeholder is a real state OpenClaw itself can leave at
    // the legacy path (see migrateLegacyMemorySidecarSource's own comment);
    // it also keeps this test from needing a full legacy sidecar schema,
    // since only the reindex-orphan reachability path is under test here.
    await fs.writeFile(legacyPath, "");

    const agedOrphan = `${legacyPath}.tmp-11111111-2222-3333-4444-555555555555`;
    const youngOrphan = `${legacyPath}.tmp-66666666-7777-8888-9999-aaaaaaaaaaaa`;
    const aged = new Date(Date.now() - 48 * 60 * 60_000);
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.writeFile(`${agedOrphan}${suffix}`, "orphan");
      await fs.utimes(`${agedOrphan}${suffix}`, aged, aged);
      // No utimes call: defaults to "just written", well inside the min age.
      await fs.writeFile(`${youngOrphan}${suffix}`, "active");
    }

    const result = await memorySidecarStateMigration.migrateLegacyState({
      config: {} as never,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: {} as never,
    });

    await expectPathMissing(agedOrphan);
    await expectPathMissing(`${agedOrphan}-wal`);
    await expectPathMissing(`${agedOrphan}-shm`);
    await expect(fs.access(youngOrphan)).resolves.toBeUndefined();
    await expect(fs.access(`${youngOrphan}-wal`)).resolves.toBeUndefined();
    await expect(fs.access(`${youngOrphan}-shm`)).resolves.toBeUndefined();
    expect(
      result.changes.some((change) => change.includes("aged Memory Core reindex orphan")),
    ).toBe(true);
  });
});
