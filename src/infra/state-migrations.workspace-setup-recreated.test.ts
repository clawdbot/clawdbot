import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

describe("recreated legacy workspace state migration", () => {
  const { migrate, setup } = useWorkspaceMigrationTestFixture();

  it("cleans a covered setup marker recreated after completed migration", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const setupPath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
    const seededAt = "2026-07-15T10:00:00.000Z";
    const completedAt = "2026-07-15T10:01:00.000Z";
    await fsp.writeFile(
      setupPath,
      JSON.stringify({ version: 1, bootstrapSeededAt: seededAt, setupCompletedAt: completedAt }),
      "utf8",
    );
    expect((await migrate(context)).warnings).toEqual([]);

    const recreated = JSON.stringify({ version: 1, setupCompletedAt: completedAt });
    await fsp.writeFile(setupPath, recreated, "utf8");

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(setupPath)).toBe(false);
    const db = openOpenClawStateDatabase({ env: context.env }).db;
    expect(
      db
        .prepare(
          "SELECT bootstrap_seeded_at, setup_completed_at FROM workspace_setup_state WHERE workspace_key = ?",
        )
        .get(identity.workspaceKey),
    ).toEqual({ bootstrap_seeded_at: seededAt, setup_completed_at: completedAt });
    const receipt = db
      .prepare(
        "SELECT source_sha256, removed_source, report_json FROM migration_sources WHERE source_path = ?",
      )
      .get(setupPath) as {
      source_sha256: string;
      removed_source: number;
      report_json: string;
    };
    expect(receipt).toMatchObject({
      source_sha256: createHash("sha256").update(recreated).digest("hex"),
      removed_source: 1,
    });
    expect(JSON.parse(receipt.report_json)).toMatchObject({
      authoritative: true,
      resolution: "verified",
    });
  });

  it.each([
    { claimed: false, state: "source" },
    { claimed: true, state: "interrupted claim" },
  ])("imports an attestation recreated as a sole $state", async ({ claimed }) => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const attestationPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${identity.workspaceKey}.attested`,
    );
    await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
    await fsp.writeFile(
      attestationPath,
      "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n",
      "utf8",
    );
    const originalMtime = new Date("2026-07-15T11:01:00.000Z");
    await fsp.utimes(attestationPath, originalMtime, originalMtime);
    expect((await migrate(context)).warnings).toEqual([]);

    const recreated = "openclaw-workspace-attestation:v1\n2026-07-16T11:00:00.000Z\n";
    await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
    await fsp.writeFile(attestationPath, recreated, "utf8");
    const recreatedMtime = new Date("2026-07-16T11:01:00.000Z");
    await fsp.utimes(attestationPath, recreatedMtime, recreatedMtime);
    const claimPath = `${attestationPath}.doctor-importing`;
    if (claimed) {
      await fsp.rename(attestationPath, claimPath);
    }

    const result = await migrate(context);

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(attestationPath)).toBe(false);
    expect(fs.existsSync(claimPath)).toBe(false);
    const db = openOpenClawStateDatabase({ env: context.env }).db;
    expect(
      db
        .prepare("SELECT attested_at_ms FROM workspace_attestations WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toEqual({ attested_at_ms: recreatedMtime.getTime() });
    expect(
      db
        .prepare(
          "SELECT source_sha256, removed_source FROM migration_sources WHERE source_path = ?",
        )
        .get(attestationPath),
    ).toEqual({
      source_sha256: createHash("sha256").update(recreated).digest("hex"),
      removed_source: 1,
    });
  });

  it("retains colliding source and claim from a recreated generation", async () => {
    const context = setup();
    const identity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const attestationPath = path.join(
      context.stateDir,
      "workspace-attestations",
      `${identity.workspaceKey}.attested`,
    );
    const original = "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n";
    await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
    await fsp.writeFile(attestationPath, original, "utf8");
    const originalMtime = new Date("2026-07-15T11:01:00.000Z");
    await fsp.utimes(attestationPath, originalMtime, originalMtime);
    expect((await migrate(context)).warnings).toEqual([]);

    const recreated = "openclaw-workspace-attestation:v1\n2026-07-16T11:00:00.000Z\n";
    const claimPath = `${attestationPath}.doctor-importing`;
    await fsp.mkdir(path.dirname(attestationPath), { recursive: true });
    await Promise.all([
      fsp.writeFile(attestationPath, recreated, "utf8"),
      fsp.writeFile(claimPath, recreated, "utf8"),
    ]);

    const result = await migrate(context);

    expect(result.warnings).toEqual([
      "Workspace state is in SQLite, but source and interrupted claim both exist.",
    ]);
    expect(fs.existsSync(attestationPath)).toBe(true);
    expect(fs.existsSync(claimPath)).toBe(true);
    const db = openOpenClawStateDatabase({ env: context.env }).db;
    expect(
      db
        .prepare("SELECT attested_at_ms FROM workspace_attestations WHERE workspace_key = ?")
        .get(identity.workspaceKey),
    ).toEqual({ attested_at_ms: originalMtime.getTime() });
    expect(
      db
        .prepare(
          "SELECT source_sha256, removed_source FROM migration_sources WHERE source_path = ?",
        )
        .get(attestationPath),
    ).toEqual({
      source_sha256: createHash("sha256").update(original).digest("hex"),
      removed_source: 1,
    });
  });
});
