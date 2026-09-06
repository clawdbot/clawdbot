// Manual same-schema proof driver. Requires a separately built exact-baseline reader;
// deliberately not a passing/skipped unit test when that artifact has not been supplied.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  assertPersistenceBundle,
  assertPersistenceSelection,
  readPersistenceDisk,
  runPersistenceChild,
} from "./persistence.test-support.js";

// Use pre-feature main after its documented pending-input schema-19 compatibility change.
const PERSISTENCE_BASE_SHA = "6a11089d4b0ed7df871650b806f71d96ad25908c";

type BaselineProvenance = {
  sourceCommit: string;
  entrypointSha256: string;
  buildCommand: string;
  sourceFiles: Record<string, string>;
};

const requiredBaselineSources = [
  "src/state/openclaw-state-db.ts",
  "src/state/openclaw-state-db-contract.ts",
  "src/state/openclaw-state-db-fast-path.ts",
  "src/state/openclaw-state-db-maintenance.ts",
  "src/state/openclaw-state-schema-compatibility.ts",
  "src/state/openclaw-state-schema.sql",
  "src/state/openclaw-agent-db.ts",
  "src/state/openclaw-agent-db-contract.ts",
  "src/state/openclaw-agent-schema.sql",
  "src/state/user-preferences.ts",
  "src/infra/sqlite-schema-contract.ts",
  "src/infra/sqlite-schema-sql.ts",
  "src/config/sessions/session-accessor.sqlite-entry.ts",
  "src/config/sessions/session-accessor.sqlite-entry-store.ts",
  "src/config/sessions/session-accessor.sqlite-session-row.ts",
  "src/config/sessions/session-entry-json.ts",
  "src/config/sessions/store-entry-shape.ts",
  "pnpm-lock.yaml",
] as const;

async function verifyBaselineArtifact(directory: string) {
  const entrypoint = path.join(directory, "reader.mjs");
  const provenance = JSON.parse(
    await fs.readFile(path.join(directory, "provenance.json"), "utf8"),
  ) as BaselineProvenance;
  assert.equal(
    provenance.sourceCommit,
    PERSISTENCE_BASE_SHA,
    "Reader must be built from the immutable pre-feature commit",
  );
  assert.ok(provenance.buildCommand, "Record the actual baseline build command for review");
  const bytes = await fs.readFile(entrypoint);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.entrypointSha256);
  for (const source of requiredBaselineSources) {
    const original = execFileSync("git", ["show", `${PERSISTENCE_BASE_SHA}:${source}`], {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(
      provenance.sourceFiles[source],
      createHash("sha256").update(original).digest("hex"),
      `Wrong/missing baseline source digest: ${source}`,
    );
  }
  // These digests make the supplied artifact auditable, not self-authenticating.
  // Parent must review its build/metafile and transitive inputs before calling it an old runtime.
  return { entrypoint, provenance };
}

async function main() {
  const artifactDirectory = process.argv[2];
  const evidencePath = process.argv[3];
  assert.ok(
    artifactDirectory && evidencePath,
    `Usage: node --import ./scripts/tsx.mjs src/skills/library/persistence-downgrade.test-support.ts <exact-baseline-artifact-dir> <new-evidence.json>; provide reader.mjs and provenance.json from ${PERSISTENCE_BASE_SHA}, not candidate code configured with old SQL.`,
  );
  const baseline = await verifyBaselineArtifact(path.resolve(artifactDirectory));
  const temps = createTempDirTracker();
  const root = await fs.realpath(temps.make("skill-library-downgrade-"));
  try {
    const seeded = await runPersistenceChild(root, { action: "seed" });
    assert.equal(seeded.kind, "seeded");
    if (seeded.kind !== "seeded") {
      throw new Error("Candidate failed to create the persistence fixture");
    }
    await runPersistenceChild(root, { action: "update-remove" });
    const before = readPersistenceDisk(root);
    assert.equal(before.stateVersion, 15);
    assert.equal(before.agentVersion, 19);
    assert.equal(before.entries.length, 2);
    assert.equal(before.revisions.length, 4);
    assert.equal(before.uploads.length, 1);
    assert.deepEqual(before.uploads[0]?.archive_blob, new Uint8Array([0x50, 0x4b]));
    for (const pin of before.pins) {
      await assertPersistenceBundle(root, pin, "old");
    }

    const older = await runPersistenceChild(root, {
      action: "older-reader",
      entrypoint: baseline.entrypoint,
      profileId: seeded.profileId,
    });
    assert.deepEqual(older, { kind: "older-reader", stateVersion: 15, agentVersion: 19 });
    const afterOld = readPersistenceDisk(root);
    assert.equal(afterOld.label, "Edited by baseline reader");
    assert.deepEqual(afterOld, { ...before, label: afterOld.label });
    const state = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
    try {
      assert.equal(
        state
          .prepare("SELECT value_json FROM user_preferences WHERE profile_id = ? AND pref_key = ?")
          .get(seeded.profileId, "library.persistence.legacy")?.value_json,
        "true",
      );
    } finally {
      state.close();
    }
    const reopened = await runPersistenceChild(root, { action: "read" });
    assertPersistenceSelection(root, reopened, before.pins);
    assert.deepEqual(readPersistenceDisk(root), afterOld);
    for (const pin of before.pins) {
      await assertPersistenceBundle(root, pin, "old");
      const current = afterOld.entries.find((row) => row.skill_id === pin.skillId)!;
      await assertPersistenceBundle(
        root,
        { ...pin, revision: String(current.current_revision) },
        "new",
      );
    }
    await fs.writeFile(
      path.resolve(evidencePath),
      JSON.stringify(
        {
          baseline: baseline.provenance,
          node: process.version,
          platform: process.platform,
          sequence: [
            "candidate publish/pin/update/remove/close",
            "baseline read-only open",
            "baseline preference write/read",
            "baseline session label patch",
            "candidate reopen and exact byte verification",
          ],
          before,
          afterOld,
          older,
          verdict: "passed",
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    process.stdout.write(
      `Same-schema baseline/candidate proof passed; evidence: ${path.resolve(evidencePath)}\n`,
    );
  } finally {
    temps.cleanup();
  }
}

await main();
