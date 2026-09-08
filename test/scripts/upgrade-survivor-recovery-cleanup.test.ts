import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRecoveryApplied,
  assertRecoveryHistory,
  assertRecoveryInventory,
  assertRecoveryOriginals,
  assertRecoverySnapshot,
  recoveryFileIdentity,
  recoveryTreeSnapshot,
  recoveryVolumeSpec,
  recoveryWalIndexPaths,
  seedRecoveryFixture,
  writeRecoveryTranscript,
} from "../../scripts/e2e/lib/upgrade-survivor/recovery-cleanup-fixture.mjs";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const temporary = () => fs.realpathSync(tempDirs.make("upgrade-recovery-assertions-"));

describe.skipIf(process.platform === "win32")("recovery survivor package provenance", () => {
  type PackageFault =
    | "metadata-version"
    | "pack-version"
    | "integrity-mismatch"
    | "missing-metadata-integrity"
    | "missing-pack-integrity";

  async function packageEvidence({
    requested = "openclaw@2026.7.1-2",
    installedVersion = "2026.7.1-2",
    packShape = "array",
    viewShape = "object",
    fault,
  }: {
    requested?: string;
    installedVersion?: string;
    packShape?: "array" | "name-keyed";
    viewShape?: "object" | "array";
    fault?: PackageFault;
  } = {}) {
    const root = temporary();
    const artifacts = path.join(root, "artifacts");
    const state = path.join(root, "state");
    const runtime = path.join(root, "runtime");
    const bin = path.join(root, "bin");
    for (const directory of [artifacts, state, runtime, bin]) {
      fs.mkdirSync(directory);
    }
    const integrity =
      installedVersion === "2026.7.1-2"
        ? "sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g=="
        : `sha512-${createHash("sha512").update(installedVersion).digest("base64")}`;
    const metadata = {
      version: fault === "metadata-version" ? "2026.1.1" : installedVersion,
      dist: {
        tarball: `https://registry.npmjs.org/openclaw/-/openclaw-${installedVersion}.tgz`,
        ...(fault === "missing-metadata-integrity" ? {} : { integrity }),
      },
    };
    const packed = {
      name: "openclaw",
      version: fault === "pack-version" ? "2026.1.1" : installedVersion,
      ...(fault === "missing-pack-integrity"
        ? {}
        : {
            integrity:
              fault === "integrity-mismatch"
                ? `sha512-${createHash("sha512").update("different bytes").digest("base64")}`
                : integrity,
          }),
    };
    const calls = path.join(root, "npm-calls.jsonl");
    fs.writeFileSync(
      path.join(bin, "npm"),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[1] !== ${JSON.stringify(`openclaw@${installedVersion}`)}) {
  throw new Error("package evidence must use the installed exact baseline");
}
if (args[0] === "view") {
  console.log(JSON.stringify(${JSON.stringify(viewShape === "array" ? [metadata] : metadata)}));
} else if (args[0] === "pack") {
  console.log(JSON.stringify(${JSON.stringify(packShape === "array" ? [packed] : { openclaw: packed })}));
} else {
  throw new Error("unexpected npm command");
}
`,
      { mode: 0o755 },
    );
    const candidate = path.join(root, "candidate.tgz");
    const candidateBytes = "candidate package fixture";
    fs.writeFileSync(candidate, candidateBytes);
    const result = await runNodeScript(
      [
        path.resolve("scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs"),
        "packages",
        requested,
        candidate,
      ],
      {
        PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
        HOME: root,
        TMPDIR: runtime,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
        OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: runtime,
        OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: installedVersion,
      },
      10_000,
    );
    return {
      result,
      metadata,
      calls: fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      evidencePath: path.join(artifacts, "recovery-evidence.json"),
      candidateSha256: createHash("sha256").update(candidateBytes).digest("hex"),
    };
  }

  it.each([
    { requested: "openclaw@2026.7.1-2", installedVersion: "2026.7.1-2", packShape: "array" },
    {
      requested: "openclaw@2026.8.2",
      installedVersion: "2026.8.2",
      packShape: "name-keyed",
      viewShape: "array",
    },
    { requested: "openclaw@latest", installedVersion: "2026.8.2", packShape: "array" },
  ] as const)(
    "verifies $requested against installed $installedVersion ($packShape)",
    async (entry) => {
      const fixture = await packageEvidence(entry);
      expect(fixture.result.error).toBeUndefined();
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      const exactSpec = `openclaw@${entry.installedVersion}`;
      expect(fixture.calls).toEqual([
        ["view", exactSpec, "version", "dist", "--json"],
        ["pack", exactSpec, "--ignore-scripts", "--dry-run", "--json"],
      ]);
      expect(JSON.parse(fs.readFileSync(fixture.evidencePath, "utf8"))).toMatchObject({
        baseline: fixture.metadata,
        candidate: { sha256: fixture.candidateSha256 },
      });
    },
  );

  it.each<PackageFault>([
    "metadata-version",
    "pack-version",
    "integrity-mismatch",
    "missing-metadata-integrity",
    "missing-pack-integrity",
  ])("rejects %s without recording successful package evidence", async (fault) => {
    const fixture = await packageEvidence({ fault });
    expect(fixture.result.error).toBeUndefined();
    expect(fixture.result.status).toBe(1);
    expect(fs.existsSync(fixture.evidencePath)).toBe(false);
  });
});

describe("recovery survivor evidence", () => {
  it("uses the existing volume controls and rejects unsafe counts", () => {
    expect(recoveryVolumeSpec({})).toEqual({ sessions: 2, eventsPerSession: 8 });
    expect(
      recoveryVolumeSpec({
        OPENCLAW_UPGRADE_SURVIVOR_VOLUME_SESSIONS: "1",
        OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION: "150000",
      }),
    ).toEqual({ sessions: 1, eventsPerSession: 150000 });
    for (const invalid of ["0", "-1", "1.5", "9007199254740992"]) {
      expect(() =>
        recoveryVolumeSpec({ OPENCLAW_UPGRADE_SURVIVOR_VOLUME_EVENTS_PER_SESSION: invalid }),
      ).toThrow();
    }
  });

  it("produces independently indexed clean and protected originals with linked large history", () => {
    const root = temporary();
    const fixture = seedRecoveryFixture(root, { sessions: 2, eventsPerSession: 5 });
    const clean = JSON.parse(
      fs.readFileSync(path.join(root, "agents/recovery-clean/sessions/sessions.json"), "utf8"),
    );
    const protectedStore = JSON.parse(
      fs.readFileSync(path.join(root, "agents/recovery-protected/sessions/sessions.json"), "utf8"),
    );
    expect(Object.keys(clean)).toHaveLength(4);
    expect(protectedStore["invalid-index-entry"]).toBe(42);
    expect(clean).not.toHaveProperty("invalid-index-entry");
    for (const original of fixture.originals) {
      expect(recoveryFileIdentity(original.source)).toEqual(original.identity);
    }
    const scale = path.join(root, "agents/recovery-clean/sessions/recovery-scale-0.jsonl");
    const events = fs
      .readFileSync(scale, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ type: "session", version: 3, id: "recovery-scale-0" });
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index].parentId).toBe(index === 1 ? null : events[index - 1].id);
    }
    expect(fs.statSync(scale).size).toBeGreaterThan(4 * 4096);
    expect(fs.readFileSync(path.join(root, "backups/operator-backup.bak"), "utf8")).toContain(
      "synthetic sentinel",
    );
  });

  it("retains unindexed sources without weakening archived-original evidence", () => {
    const root = temporary();
    const fixture = seedRecoveryFixture(root, { sessions: 1, eventsPerSession: 3 });
    const retainedSource = path.join(
      root,
      "agents/recovery-protected/sessions/recovery-unreferenced.jsonl",
    );
    const originals = fixture.originals.filter((original) => original.source === retainedSource);
    expect(originals).toHaveLength(1);
    expect(assertRecoveryOriginals({ originals }, [])).toMatchObject([
      {
        source: retainedSource,
        archive: retainedSource,
        disposition: "unmanifested",
        reported: false,
      },
    ]);
    expect(() => assertRecoveryOriginals({ originals }, [{ sourcePath: retainedSource }])).toThrow(
      /recorded/,
    );
    const archivedSource = path.join(
      root,
      "agents/recovery-clean/sessions/recovery-unreferenced.jsonl",
    );
    const archived = fixture.originals.filter((original) => original.source === archivedSource);
    expect(archived).toHaveLength(1);
    expect(() => assertRecoveryOriginals({ originals: archived }, [])).toThrow(/did not record/);
    fs.appendFileSync(retainedSource, "unexpected change");
    expect(() => assertRecoveryOriginals({ originals }, [])).toThrow(/changed/);
  });

  it("does not overwrite an existing transcript when seeding", () => {
    const file = path.join(temporary(), "history.jsonl");
    fs.writeFileSync(file, "existing history");
    expect(() => writeRecoveryTranscript(file, "session", 3)).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("existing history");
  });

  it("detects preview mutations to databases, directories, cache files, and identities", () => {
    const root = temporary();
    const database = path.join(root, "current.sqlite");
    fs.writeFileSync(database, "synthetic database bytes");
    const before = recoveryTreeSnapshot([root]);
    expect(() => assertRecoverySnapshot(before, recoveryTreeSnapshot([root]))).not.toThrow();
    fs.mkdirSync(path.join(root, "new-cache"));
    expect(() => assertRecoverySnapshot(before, recoveryTreeSnapshot([root]))).toThrow();
    fs.rmSync(path.join(root, "new-cache"), { recursive: true });
    const stable = recoveryTreeSnapshot([root]);
    fs.writeFileSync(database, "changed database bytes");
    expect(() => assertRecoverySnapshot(stable, recoveryTreeSnapshot([root]))).toThrow();
  });

  it("allows only selected transient WAL indexes during offline maintenance", () => {
    const root = temporary();
    const database = path.join(root, "current.sqlite");
    const wal = `${database}-wal`;
    const shm = `${database}-shm`;
    const unrelatedShm = path.join(root, "unrelated.sqlite-shm");
    const sharedShm = path.join(root, "state", "openclaw.sqlite-shm");
    fs.mkdirSync(path.dirname(sharedShm));
    for (const file of [database, wal, shm, unrelatedShm, sharedShm]) {
      fs.writeFileSync(file, "original bytes");
    }
    const before = recoveryTreeSnapshot([root]);
    fs.writeFileSync(shm, "rebuilt agent WAL index");
    fs.writeFileSync(sharedShm, "rebuilt state WAL index");
    const after = recoveryTreeSnapshot([root]);
    expect(() => assertRecoverySnapshot(before, after)).toThrow();
    const allowed = recoveryWalIndexPaths(root, [{ sqlitePath: database }]);
    expect(() => assertRecoverySnapshot(before, after, allowed, true)).not.toThrow();

    for (const file of [database, wal, unrelatedShm]) {
      const baseline = recoveryTreeSnapshot([root]);
      fs.appendFileSync(file, "unexpected change");
      expect(() =>
        assertRecoverySnapshot(baseline, recoveryTreeSnapshot([root]), allowed, true),
      ).toThrow();
    }
  });

  it("requires the preserved original inode and content, not just a matching manifest", () => {
    const root = temporary();
    const source = path.join(root, "original.jsonl");
    const archive = path.join(root, "archive.jsonl");
    writeRecoveryTranscript(source, "old", 3);
    const identity = recoveryFileIdentity(source);
    const fixture = { originals: [{ source, identity, disposition: "candidate" }] };
    const moves = [
      {
        sourcePath: source,
        archivePath: archive,
        manifestVersion: 3,
        runId: "run",
        completedAt: "2026-07-01T00:00:00Z",
        artifact: { identity, classification: "imported", disposal: { state: "retained" } },
      },
    ];
    fs.renameSync(source, archive);
    expect(assertRecoveryOriginals(fixture, moves)[0]?.archive).toBe(archive);
    fs.appendFileSync(archive, "unexpected rewrite");
    expect(() => assertRecoveryOriginals(fixture, moves)).toThrow(/copied or rewritten/);
    fs.rmSync(archive);
    expect(() => assertRecoveryOriginals(fixture, moves)).toThrow();
  });

  it("rejects missing or misclassified originals even when aggregate candidates are nonzero", () => {
    const originals = [
      { archive: "/synthetic/clean", disposition: "candidate", identity: { size: 12 } },
      { archive: "/synthetic/protected", disposition: "protected", identity: { size: 17 } },
    ];
    const preview = {
      status: "preview",
      dryRun: true,
      artifacts: [
        {
          path: "/synthetic/clean",
          outcome: "candidate",
          bytes: 12,
          reason: "verified",
          runs: ["run"],
        },
        {
          path: "/synthetic/protected",
          outcome: "protected",
          bytes: 17,
          reason: "unimported",
          runs: ["run"],
        },
      ],
      totals: { candidateBytes: 12, protectedBytes: 17 },
    };
    expect(() => assertRecoveryInventory(preview, originals)).not.toThrow();
    expect(() =>
      assertRecoveryInventory({ ...preview, artifacts: preview.artifacts.slice(0, 1) }, originals),
    ).toThrow(/omitted/);
    const wrong = structuredClone(preview);
    wrong.artifacts[1]!.outcome = "candidate";
    expect(() => assertRecoveryInventory(wrong, originals)).toThrow(/classification/);
    expect(() => assertRecoveryInventory({ status: "preview" }, originals)).toThrow();
  });

  it("requires actual deletion, exact accounting, protected bytes, and every disposal receipt", () => {
    const root = temporary();
    const removedPath = path.join(root, "eligible");
    const protectedPath = path.join(root, "protected");
    fs.writeFileSync(removedPath, "eligible payload");
    fs.writeFileSync(protectedPath, "unique history");
    const originals = [
      {
        archive: removedPath,
        disposition: "candidate",
        identity: recoveryFileIdentity(removedPath),
      },
      {
        archive: protectedPath,
        disposition: "protected",
        identity: recoveryFileIdentity(protectedPath),
      },
    ];
    const bytes = originals[0]!.identity.size;
    const preview = { artifacts: [{ path: removedPath, outcome: "candidate", bytes }] };
    const report = {
      status: "complete",
      dryRun: false,
      artifacts: [
        {
          path: removedPath,
          outcome: "removed",
          removedBytes: bytes,
          reason: "rollback-original-retired",
        },
      ],
      totals: { removedFiles: 1, removedBytes: bytes },
    };
    const receipts = [
      {
        archivePath: removedPath,
        artifact: { disposal: { state: "disposed", disposedAt: "2026-07-01T00:00:00Z" } },
      },
    ];
    expect(() => assertRecoveryApplied(report, preview, originals, receipts)).toThrow(
      /still exists/,
    );
    fs.rmSync(removedPath);
    expect(assertRecoveryApplied(report, preview, originals, receipts)).toEqual([removedPath]);
    expect(() => assertRecoveryApplied(report, preview, originals, [])).toThrow(/receipt/);
    expect(() =>
      assertRecoveryApplied(report, preview, originals, [
        ...receipts,
        { archivePath: removedPath, artifact: { disposal: { state: "retained" } } },
      ]),
    ).toThrow(/receipt/);
    expect(() =>
      assertRecoveryApplied(
        { ...report, totals: { removedFiles: 1, removedBytes: 0 } },
        preview,
        originals,
        receipts,
      ),
    ).toThrow();
    fs.writeFileSync(protectedPath, "lost unique history");
    expect(() => assertRecoveryApplied(report, preview, originals, receipts)).toThrow(/protected/);
  });

  it("detects public history loss, reordering, and changed session identity", () => {
    const expected = ["old", "new"].map((id) => ({
      id,
      role: "assistant",
      content: [{ type: "text", text: id }],
    }));
    const messages = expected.map(({ id, ...message }) => ({ ...message, __openclaw: { id } }));
    expect(() =>
      assertRecoveryHistory({ sessionId: "session", messages }, "session", expected),
    ).not.toThrow();
    expect(() =>
      assertRecoveryHistory({ sessionId: "replacement", messages }, "session", expected),
    ).toThrow(/identity/);
    expect(() =>
      assertRecoveryHistory(
        { sessionId: "session", messages: messages.slice(1) },
        "session",
        expected,
      ),
    ).toThrow(/content or order/);
    expect(() =>
      assertRecoveryHistory(
        { sessionId: "session", messages: messages.toReversed() },
        "session",
        expected,
      ),
    ).toThrow(/content or order/);
    expect(() =>
      assertRecoveryHistory(
        {
          sessionId: "session",
          messages: messages.map(({ role, content }) => ({ role, content })),
        },
        "session",
        expected,
      ),
    ).toThrow(/message identity/);
  });
});
