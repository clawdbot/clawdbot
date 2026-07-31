import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { skillRoot } from "../scripts/charrette-lib.mjs";
import { sha256 } from "../scripts/json-utils.mjs";
import { inventoriesEqual, inventoryTree } from "../scripts/tree-integrity.mjs";

const timestamp = "2026-07-30T15:00:00.000Z";

async function temporaryDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "cyborgclaw-charrette-install-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function runInstaller(root, args) {
  return spawnSync(process.execPath, [join(root, "scripts", "install.mjs"), ...args], {
    encoding: "utf8",
  });
}

function parsedOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function parsedError(result) {
  assert.notEqual(result.status, 0, result.stdout);
  return JSON.parse(result.stderr);
}

function statePaths(targetRoot) {
  const state = join(targetRoot, `.${basename(skillRoot)}-state`);
  return {
    state,
    journals: join(state, "journals"),
    receipts: join(state, "receipts"),
    current: join(state, "current.json"),
  };
}

async function setSourceVersion(source, version) {
  for (const relativePath of ["manifest.json", "references/CONTRACT_CONSTANTS.json"]) {
    const path = join(source, relativePath);
    const value = JSON.parse(await readFile(path, "utf8"));
    if (relativePath === "manifest.json") {
      value.version = version;
    } else {
      value.skill_version = version;
    }
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  const checksum = spawnSync(
    process.execPath,
    [join(source, "scripts", "build-checksums.mjs"), "--root", source],
    { encoding: "utf8" },
  );
  assert.equal(checksum.status, 0, checksum.stderr);
}

async function makeVersionedSource(parent, version) {
  const source = join(parent, basename(skillRoot));
  await mkdir(parent, { recursive: true });
  await cp(skillRoot, source, { recursive: true });
  await setSourceVersion(source, version);
  return source;
}

test("clean install is exact and a repeat is a verified no-op", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "missing", "skills");
  const first = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  assert.equal(first.disposition, "INSTALLED");
  assert.equal(first.exact_identity, true);
  const installed = join(targetRoot, basename(skillRoot));
  assert.ok(inventoriesEqual(await inventoryTree(skillRoot), await inventoryTree(installed)));
  const state = join(targetRoot, `.${basename(skillRoot)}-state`);
  const backupCount = (await readdir(join(state, "backups"))).length;
  const second = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  assert.equal(second.disposition, "VERIFIED_NOOP");
  assert.equal((await readdir(join(state, "backups"))).length, backupCount);
});

test("timestamps must use exact canonical UTC millisecond form", async (t) => {
  const root = await temporaryDirectory(t);
  for (const invalid of [
    "0",
    "2026-07-30T15:00:00Z",
    "2026-07-30T15:00:00.000+00:00",
    "2026-02-30T15:00:00.000Z",
  ]) {
    const result = runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      join(root, invalid.replaceAll(/[^a-z0-9]/gi, "-")),
      "--timestamp",
      invalid,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /USAGE|canonical UTC/);
  }
});

test("dry-run on an absent target writes nothing", async (t) => {
  const root = await temporaryDirectory(t);
  const before = await readdir(root);
  const result = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      join(root, "uncreated", "skills"),
      "--dry-run",
      "--timestamp",
      timestamp,
    ]),
  );
  assert.equal(result.disposition, "INSTALL");
  assert.equal(result.provisional, true);
  assert.deepEqual(await readdir(root), before);
});

test("an unmanaged byte-identical target is adopted before it can be a verified no-op", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "skills");
  const target = join(targetRoot, basename(skillRoot));
  await mkdir(targetRoot);
  await cp(skillRoot, target, { recursive: true });

  const dryRun = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--dry-run",
      "--timestamp",
      timestamp,
    ]),
  );
  assert.equal(dryRun.disposition, "ADOPT_IDENTICAL");

  const adopted = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  assert.equal(adopted.disposition, "ADOPTED_IDENTICAL");
  assert.equal(adopted.backup_id, null);
  const paths = statePaths(targetRoot);
  const pointer = JSON.parse(await readFile(paths.current, "utf8"));
  assert.equal(pointer.receipt_id, adopted.receipt_id);

  const repeated = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  assert.equal(repeated.disposition, "VERIFIED_NOOP");
});

test("unknown different target is refused without changing its sentinel", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "skills");
  const target = join(targetRoot, basename(skillRoot));
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "sentinel.txt"), "preserve-me\n");
  const result = runInstaller(skillRoot, [
    "--source",
    skillRoot,
    "--target-root",
    targetRoot,
    "--timestamp",
    timestamp,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNKNOWN_TARGET|unexpected manifest/i);
  assert.equal(await readFile(join(target, "sentinel.txt"), "utf8"), "preserve-me\n");
});

test("source and target symlinks are rejected without touching sentinels", async (t) => {
  const root = await temporaryDirectory(t);
  const sourceLink = join(root, basename(skillRoot));
  await symlink(skillRoot, sourceLink);
  const linkedSource = runInstaller(skillRoot, [
    "--source",
    sourceLink,
    "--target-root",
    join(root, "source-link-target"),
  ]);
  assert.notEqual(linkedSource.status, 0);
  assert.match(linkedSource.stderr, /Symlink/i);

  const realRoot = join(root, "real-root");
  await mkdir(realRoot);
  await writeFile(join(realRoot, "sentinel.txt"), "untouched\n");
  const targetRootLink = join(root, "linked-root");
  await symlink(realRoot, targetRootLink);
  const linkedTarget = runInstaller(skillRoot, [
    "--source",
    skillRoot,
    "--target-root",
    targetRootLink,
  ]);
  assert.notEqual(linkedTarget.status, 0);
  assert.match(linkedTarget.stderr, /Symlink/i);
  assert.equal(await readFile(join(realRoot, "sentinel.txt"), "utf8"), "untouched\n");
});

test("inventory detects extra files, mode drift, empty directories, symlinks, and hardlinks", async (t) => {
  const root = await temporaryDirectory(t);
  const copyRoot = join(root, basename(skillRoot));
  await cp(skillRoot, copyRoot, { recursive: true });
  const baseline = await inventoryTree(copyRoot);
  await writeFile(join(copyRoot, "extra.txt"), "extra\n");
  assert.notEqual((await inventoryTree(copyRoot)).digest, baseline.digest);
  await rm(join(copyRoot, "extra.txt"));
  await mkdir(join(copyRoot, "empty-directory"));
  assert.notEqual((await inventoryTree(copyRoot)).digest, baseline.digest);
  await rm(join(copyRoot, "empty-directory"), { recursive: true });
  const originalMode = baseline.entries.find((entry) => entry.path === "SKILL.md").mode;
  await chmod(join(copyRoot, "SKILL.md"), originalMode ^ 0o100);
  assert.notEqual((await inventoryTree(copyRoot)).digest, baseline.digest);
  await chmod(join(copyRoot, "SKILL.md"), originalMode);
  await symlink("SKILL.md", join(copyRoot, "payload-link"));
  await assert.rejects(inventoryTree(copyRoot), /Symlinks/);
  await rm(join(copyRoot, "payload-link"));
  await link(join(copyRoot, "SKILL.md"), join(copyRoot, "payload-hardlink"));
  await assert.rejects(inventoryTree(copyRoot), /Hard-linked/);
});

test("known update creates a verified backup and receipt-bound rollback", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "skills");
  const initial = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  const originalInventory = await inventoryTree(skillRoot);
  assert.equal(initial.disposition, "INSTALLED");

  const nextSource = await makeVersionedSource(join(root, "next-source"), "1.1.0");

  const update = parsedOutput(
    runInstaller(nextSource, [
      "--source",
      nextSource,
      "--target-root",
      targetRoot,
      "--timestamp",
      "2026-07-30T16:00:00.000Z",
    ]),
  );
  assert.equal(update.disposition, "UPDATED");
  assert.equal(update.backup_id, update.receipt_id);
  const state = join(targetRoot, `.${basename(skillRoot)}-state`);
  const backup = join(state, "backups", update.backup_id);
  assert.ok(inventoriesEqual(originalInventory, await inventoryTree(backup)));

  const installedRoot = join(targetRoot, basename(skillRoot));
  const rollback = parsedOutput(
    runInstaller(installedRoot, [
      "rollback",
      "--target-root",
      targetRoot,
      "--receipt-id",
      update.receipt_id,
      "--timestamp",
      "2026-07-30T17:00:00.000Z",
    ]),
  );
  assert.equal(rollback.disposition, "ROLLED_BACK");
  assert.ok(inventoriesEqual(originalInventory, await inventoryTree(installedRoot)));
  assert.ok((await readdir(join(state, "backups"))).length >= 2);
});

test("recovery restores the prior tree and pointer when the activation source drifted", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "skills");
  const initial = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  const originalInventory = await inventoryTree(skillRoot);
  const nextSource = await makeVersionedSource(join(root, "next-source"), "1.1.0");
  const update = parsedOutput(
    runInstaller(nextSource, [
      "--source",
      nextSource,
      "--target-root",
      targetRoot,
      "--timestamp",
      "2026-07-30T16:00:00.000Z",
    ]),
  );
  const paths = statePaths(targetRoot);
  const journalPath = join(paths.journals, `${update.receipt_id}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.phase = "NEW_ACTIVE";
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await setSourceVersion(nextSource, "1.2.0");

  const result = runInstaller(nextSource, [
    "--source",
    nextSource,
    "--target-root",
    targetRoot,
    "--timestamp",
    "2026-07-30T17:00:00.000Z",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SOURCE_DRIFT/);
  const installedRoot = join(targetRoot, basename(skillRoot));
  assert.ok(inventoriesEqual(originalInventory, await inventoryTree(installedRoot)));
  assert.equal(JSON.parse(await readFile(paths.current, "utf8")).receipt_id, initial.receipt_id);
  assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "RESTORED");
});

test("same-user drift from a current receipt is refused", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "skills");
  parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  const target = join(targetRoot, basename(skillRoot));
  await writeFile(join(target, "drift.txt"), "unexpected\n");
  const result = runInstaller(skillRoot, [
    "--source",
    skillRoot,
    "--target-root",
    targetRoot,
    "--timestamp",
    timestamp,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TARGET_DRIFT/);
  assert.equal(await readFile(join(target, "drift.txt"), "utf8"), "unexpected\n");
});

test("receipt recovery completes either half of an immutable receipt pair", async (t) => {
  const root = await temporaryDirectory(t);
  for (const missing of ["json", "sha256"]) {
    const targetRoot = join(root, missing, "skills");
    const installed = parsedOutput(
      runInstaller(skillRoot, [
        "--source",
        skillRoot,
        "--target-root",
        targetRoot,
        "--timestamp",
        timestamp,
      ]),
    );
    const paths = statePaths(targetRoot);
    const journalPath = join(paths.journals, `${installed.receipt_id}.json`);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.phase = "NEW_ACTIVE";
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
    await rm(paths.current);
    await rm(join(paths.receipts, `${installed.receipt_id}.${missing}`));

    const recovered = parsedOutput(
      runInstaller(skillRoot, [
        "--source",
        skillRoot,
        "--target-root",
        targetRoot,
        "--timestamp",
        timestamp,
      ]),
    );
    assert.equal(recovered.disposition, "VERIFIED_NOOP");
    const receiptBytes = await readFile(join(paths.receipts, `${installed.receipt_id}.json`));
    assert.equal(
      await readFile(join(paths.receipts, `${installed.receipt_id}.sha256`), "utf8"),
      `${sha256(receiptBytes)}\n`,
    );
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).phase, "COMPLETE");
  }
});

test("dry-run validates custody state and refuses a transaction requiring recovery", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "skills");
  const installed = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  const paths = statePaths(targetRoot);
  const journalPath = join(paths.journals, `${installed.receipt_id}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.phase = "NEW_ACTIVE";
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  const before = await readFile(journalPath);

  const result = runInstaller(skillRoot, [
    "--source",
    skillRoot,
    "--target-root",
    targetRoot,
    "--dry-run",
    "--timestamp",
    timestamp,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RECOVERY_REQUIRED/);
  assert.deepEqual(await readFile(journalPath), before);
});

test("recovery rejects a journal path injection without touching the named path", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "skills");
  const installed = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  const paths = statePaths(targetRoot);
  const originalJournal = JSON.parse(
    await readFile(join(paths.journals, `${installed.receipt_id}.json`), "utf8"),
  );
  const transactionId = "33333333-3333-4333-8333-333333333333";
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel.txt"), "do-not-move\n");
  const hostileJournal = structuredClone(originalJournal);
  hostileJournal.transaction_id = transactionId;
  hostileJournal.phase = "PREPARED";
  hostileJournal.stage_path = outside;
  hostileJournal.receipt.receipt_id = transactionId;
  await writeFile(
    join(paths.journals, `${transactionId}.json`),
    `${JSON.stringify(hostileJournal, null, 2)}\n`,
  );

  const result = runInstaller(skillRoot, [
    "--source",
    skillRoot,
    "--target-root",
    targetRoot,
    "--timestamp",
    timestamp,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AMBIGUOUS_RECOVERY|path linkage/i);
  assert.equal(await readFile(join(outside, "sentinel.txt"), "utf8"), "do-not-move\n");
});

test("state pointer reads reject hard links, unsafe permissions, and symlinks", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "skills");
  parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  const paths = statePaths(targetRoot);
  const hardLink = join(root, "current-hardlink.json");
  await link(paths.current, hardLink);
  const hardLinked = runInstaller(skillRoot, [
    "--source",
    skillRoot,
    "--target-root",
    targetRoot,
    "--timestamp",
    timestamp,
  ]);
  assert.notEqual(hardLinked.status, 0);
  assert.match(hardLinked.stderr, /INVALID_RECEIPT|hard-linked/i);

  await rm(hardLink);
  await chmod(paths.current, 0o666);
  const writable = runInstaller(skillRoot, [
    "--source",
    skillRoot,
    "--target-root",
    targetRoot,
    "--timestamp",
    timestamp,
  ]);
  assert.notEqual(writable.status, 0);
  assert.match(writable.stderr, /INVALID_RECEIPT|permissions/i);

  await chmod(paths.current, 0o600);
  const realPointer = join(root, "real-current.json");
  await rename(paths.current, realPointer);
  await symlink(realPointer, paths.current);
  const linked = runInstaller(skillRoot, [
    "--source",
    skillRoot,
    "--target-root",
    targetRoot,
    "--timestamp",
    timestamp,
  ]);
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /INVALID_RECEIPT|Symlink/i);
});

test("state and receipt text rejects malformed UTF-8 with custody-specific errors", async (t) => {
  const root = await temporaryDirectory(t);
  const malformedUtf8 = Buffer.from([0xc3, 0x28]);

  for (const targetName of ["current", "receipt", "detached-hash"]) {
    const targetRoot = join(root, targetName, "skills");
    const installed = parsedOutput(
      runInstaller(skillRoot, [
        "--source",
        skillRoot,
        "--target-root",
        targetRoot,
        "--timestamp",
        timestamp,
      ]),
    );
    const paths = statePaths(targetRoot);
    if (targetName === "current") {
      await writeFile(paths.current, malformedUtf8);
    } else if (targetName === "receipt") {
      await writeFile(join(paths.receipts, `${installed.receipt_id}.json`), malformedUtf8);
      await writeFile(
        join(paths.receipts, `${installed.receipt_id}.sha256`),
        `${sha256(malformedUtf8)}\n`,
      );
    } else {
      await writeFile(join(paths.receipts, `${installed.receipt_id}.sha256`), malformedUtf8);
    }

    const error = parsedError(
      runInstaller(skillRoot, [
        "--source",
        skillRoot,
        "--target-root",
        targetRoot,
        "--timestamp",
        timestamp,
      ]),
    );
    assert.equal(error.code, "INVALID_RECEIPT");
    assert.match(error.error, /malformed UTF-8/);
  }
});

test("a live lock is never stolen", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "skills");
  const state = join(targetRoot, `.${basename(skillRoot)}-state`);
  const lock = join(state, "lock");
  await mkdir(lock, { recursive: true });
  const owner = {
    schema_version: "cyborgclaw.skill-install-lock.v1",
    nonce: "11111111-1111-4111-8111-111111111111",
    pid: process.pid,
    hostname: hostname(),
    started_at: timestamp,
  };
  await writeFile(join(lock, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`);
  const result = runInstaller(skillRoot, [
    "--source",
    skillRoot,
    "--target-root",
    targetRoot,
    "--timestamp",
    timestamp,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LOCKED/);
  assert.deepEqual(JSON.parse(await readFile(join(lock, "owner.json"), "utf8")), owner);
});

test("a provably stale same-host lock is preserved and recovered", async (t) => {
  const root = await temporaryDirectory(t);
  const targetRoot = join(root, "skills");
  const state = join(targetRoot, `.${basename(skillRoot)}-state`);
  const lock = join(state, "lock");
  await mkdir(lock, { recursive: true });
  const nonce = "22222222-2222-4222-8222-222222222222";
  await writeFile(
    join(lock, "owner.json"),
    `${JSON.stringify(
      {
        schema_version: "cyborgclaw.skill-install-lock.v1",
        nonce,
        pid: 999999999,
        hostname: hostname(),
        started_at: timestamp,
      },
      null,
      2,
    )}\n`,
  );
  const result = parsedOutput(
    runInstaller(skillRoot, [
      "--source",
      skillRoot,
      "--target-root",
      targetRoot,
      "--timestamp",
      timestamp,
    ]),
  );
  assert.equal(result.disposition, "INSTALLED");
  assert.ok((await readdir(state)).some((name) => name.startsWith(`stale-lock-${nonce}-`)));
});

test("source-target overlap is rejected before installer state is written", () => {
  const result = runInstaller(skillRoot, [
    "--source",
    skillRoot,
    "--target-root",
    join(skillRoot, ".."),
    "--timestamp",
    timestamp,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /overlap/i);
});
