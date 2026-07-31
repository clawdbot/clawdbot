#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { constants, skillRoot } from "./charrette-lib.mjs";
import {
  canonicalJson,
  decodeUtf8Strict,
  parseJsonStrict,
  prettyJson,
  readJsonStrict,
  sha256,
} from "./json-utils.mjs";
import {
  assertNoSymlinkAncestors,
  copyInventory,
  inventoriesEqual,
  inventoryTree,
  isContained,
  lstatOptional,
  realDirectory,
} from "./tree-integrity.mjs";

const skillName = "cyborgclaw-groupthink-charrette";
const stateName = `.${skillName}-state`;
const receiptSchema = "cyborgclaw.skill-install-receipt.v1";
const journalSchema = "cyborgclaw.skill-install-journal.v1";
const receiptClaimBoundary =
  "Hashes prove logical payload equality and receipt integrity, not authenticity against a same-user attacker or uninterrupted directory replacement.";
const canonicalUtcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const maximumStateFileBytes = 1024 * 1024;

class InstallError extends Error {
  constructor(message, code = "INSTALL_ERROR") {
    super(message);
    this.name = "InstallError";
    this.code = code;
  }
}

function assertCanonicalUtcTimestamp(value, label, code = "INVALID_STATE") {
  if (
    typeof value !== "string" ||
    !canonicalUtcPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new InstallError(`${label} must be canonical UTC with millisecond precision`, code);
  }
}

function assertExactKeys(value, expected, label, code = "INVALID_STATE") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InstallError(`${label} must be an object`, code);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new InstallError(`${label} has unexpected fields`, code);
  }
}

function assertSha256(value, label, { nullable = false, code = "INVALID_STATE" } = {}) {
  if (nullable && value === null) {
    return;
  }
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new InstallError(`${label} must be a lowercase SHA-256 digest`, code);
  }
}

function assertSafeOwnedStatus(status, label, type, code = "INVALID_STATE") {
  const typeMatches =
    type === "file"
      ? status.isFile() && !status.isSymbolicLink()
      : status.isDirectory() && !status.isSymbolicLink();
  if (!typeMatches) {
    throw new InstallError(`${label} is not a safe ${type}`, code);
  }
  if (type === "file" && status.nlink !== 1) {
    throw new InstallError(`${label} must not be hard-linked`, code);
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new InstallError(`${label} is not owned by the current user`, code);
  }
  const requiredOwnerPermissions = type === "file" ? 0o400 : 0o500;
  if (
    (status.mode & 0o022) !== 0 ||
    (status.mode & requiredOwnerPermissions) !== requiredOwnerPermissions
  ) {
    throw new InstallError(`${label} has unsafe owner permissions`, code);
  }
}

async function assertSafeStateDirectory(path, label = path, code = "INVALID_STATE") {
  await assertNoSymlinkAncestors(path);
  const status = await lstatOptional(path);
  if (status === null) {
    throw new InstallError(`${label} does not exist`, code);
  }
  assertSafeOwnedStatus(status, label, "directory", code);
  return status;
}

async function readSafeStateFile(path, label = path, code = "INVALID_STATE") {
  await assertNoSymlinkAncestors(path);
  const pathStatus = await lstatOptional(path);
  if (pathStatus === null) {
    const error = new Error(`No such state file: ${path}`);
    error.code = "ENOENT";
    throw error;
  }
  assertSafeOwnedStatus(pathStatus, label, "file", code);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const openedStatus = await handle.stat();
    assertSafeOwnedStatus(openedStatus, label, "file", code);
    if (openedStatus.dev !== pathStatus.dev || openedStatus.ino !== pathStatus.ino) {
      throw new InstallError(`${label} changed before it could be read`, code);
    }
    if (openedStatus.size > maximumStateFileBytes) {
      throw new InstallError(`${label} exceeds the state-file size limit`, code);
    }
    const bytes = await handle.readFile();
    const afterStatus = await handle.stat();
    if (
      afterStatus.size !== openedStatus.size ||
      afterStatus.mtimeNs !== openedStatus.mtimeNs ||
      afterStatus.dev !== openedStatus.dev ||
      afterStatus.ino !== openedStatus.ino
    ) {
      throw new InstallError(`${label} changed while it was read`, code);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readSafeStateJson(path, label = path, code = "INVALID_STATE") {
  const bytes = await readSafeStateFile(path, label, code);
  return parseJsonStrict(decodeStateText(bytes, path, label, code), path);
}

function decodeStateText(bytes, path, label, code) {
  try {
    return decodeUtf8Strict(bytes, path, maximumStateFileBytes);
  } catch (error) {
    throw new InstallError(`${label} is not valid UTF-8: ${error.message}`, code);
  }
}

async function writeExclusiveStateFile(path, bytes, mode = 0o600) {
  await assertSafeStateDirectory(dirname(path), `State parent for ${path}`);
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseArguments(argv) {
  const args = [...argv];
  const command = args[0]?.startsWith("--") || args.length === 0 ? "install" : args.shift();
  if (!["install", "rollback"].includes(command)) {
    throw new InstallError(`Unknown command: ${command}`, "USAGE");
  }
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag.startsWith("--")) {
      throw new InstallError(`Expected a flag, got ${flag}`, "USAGE");
    }
    if (flags.has(flag)) {
      throw new InstallError(`Duplicate flag: ${flag}`, "USAGE");
    }
    if (flag === "--dry-run") {
      flags.set(flag, true);
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      throw new InstallError(`${flag} requires a value`, "USAGE");
    }
    flags.set(flag, value);
  }
  const allowed = new Set([
    "--source",
    "--target-root",
    "--timestamp",
    "--dry-run",
    "--receipt-id",
  ]);
  for (const flag of flags.keys()) {
    if (!allowed.has(flag)) {
      throw new InstallError(`Unknown flag: ${flag}`, "USAGE");
    }
  }
  if (command === "rollback" && !flags.has("--receipt-id")) {
    throw new InstallError("rollback requires --receipt-id", "USAGE");
  }
  if (command === "rollback" && flags.has("--source")) {
    throw new InstallError("rollback does not accept --source", "USAGE");
  }
  if (command === "install" && flags.has("--receipt-id")) {
    throw new InstallError("install does not accept --receipt-id", "USAGE");
  }
  const timestamp = flags.get("--timestamp") ?? new Date().toISOString();
  assertCanonicalUtcTimestamp(timestamp, "--timestamp", "USAGE");
  return {
    command,
    source: resolve(flags.get("--source") ?? skillRoot),
    targetRoot: resolve(flags.get("--target-root") ?? join(homedir(), ".agents", "skills")),
    timestamp,
    dryRun: flags.has("--dry-run"),
    receiptId: flags.get("--receipt-id") ?? null,
  };
}

function assertUuid(value, label, code = "INVALID_STATE") {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new InstallError(`${label} is not a canonical UUID`, code);
  }
}

function parseVersion(value, code = "INVALID_VERSION") {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new InstallError(`Unsupported semantic version: ${value}`, code);
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path, bytes, mode = 0o600) {
  await assertSafeStateDirectory(dirname(path), `State parent for ${path}`);
  const destinationStatus = await lstatOptional(path);
  if (destinationStatus !== null) {
    assertSafeOwnedStatus(destinationStatus, path, "file");
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function writeAtomicJson(path, value) {
  await writeAtomic(path, Buffer.from(prettyJson(value)));
}

async function ensureRealDirectory(path, mode = 0o700) {
  await assertNoSymlinkAncestors(path);
  const existing = await lstatOptional(path);
  if (existing === null) {
    await mkdir(path, { mode });
  } else {
    assertSafeOwnedStatus(existing, path, "directory", "UNSAFE_PATH");
  }
  await assertNoSymlinkAncestors(path);
  await assertSafeStateDirectory(path, path, "UNSAFE_PATH");
}

async function loadManifest(root) {
  const manifest = await readJsonStrict(join(root, "manifest.json"));
  if (
    manifest.name !== skillName ||
    manifest.version !== constants.skill_version ||
    !Array.isArray(manifest.runtime_dependencies) ||
    manifest.runtime_dependencies.length !== 0
  ) {
    throw new InstallError("Source manifest violates the skill contract", "INVALID_SOURCE");
  }
  if (compareVersions(process.versions.node.split("-")[0], manifest.minimum_node_version) < 0) {
    throw new InstallError(
      `Node ${manifest.minimum_node_version}+ is required`,
      "UNSUPPORTED_RUNTIME",
    );
  }
  return manifest;
}

async function loadInstalledManifest(root) {
  let manifest;
  try {
    manifest = await readJsonStrict(join(root, "manifest.json"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new InstallError("Existing target has no manifest", "UNKNOWN_TARGET");
    }
    throw error;
  }
  if (manifest.name !== skillName) {
    throw new InstallError("Existing target has an unexpected manifest name", "UNKNOWN_TARGET");
  }
  parseVersion(manifest.version);
  return manifest;
}

function checksumText(inventory) {
  return `${inventory.entries
    .filter((entry) => entry.type === "file" && entry.path !== "SHA256SUMS.sha256")
    .map((entry) => `${entry.sha256}  ${entry.path}`)
    .join("\n")}\n`;
}

async function verifyPayloadChecksums(root, inventory) {
  const actual = await readFile(join(root, "SHA256SUMS.sha256"), "utf8");
  if (actual !== checksumText(inventory)) {
    throw new InstallError("Payload checksum manifest is stale", "INVALID_SOURCE");
  }
}

function statePaths(targetRoot) {
  const state = join(targetRoot, stateName);
  return {
    state,
    lock: join(state, "lock"),
    journals: join(state, "journals"),
    stages: join(state, "stages"),
    backups: join(state, "backups"),
    receipts: join(state, "receipts"),
    current: join(state, "current.json"),
  };
}

async function initializeState(paths) {
  await ensureRealDirectory(paths.state);
  for (const path of [paths.journals, paths.stages, paths.backups, paths.receipts]) {
    await ensureRealDirectory(path);
  }
}

async function validateStateLayout(paths) {
  await assertSafeStateDirectory(paths.state, "Installer state directory");
  for (const [label, path] of [
    ["Journal directory", paths.journals],
    ["Stage directory", paths.stages],
    ["Backup directory", paths.backups],
    ["Receipt directory", paths.receipts],
  ]) {
    await assertSafeStateDirectory(path, label);
  }
}

function pidIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function validateLockOwner(owner) {
  assertExactKeys(
    owner,
    ["schema_version", "nonce", "pid", "hostname", "started_at"],
    "Installer lock",
    "LOCKED",
  );
  if (
    owner.schema_version !== "cyborgclaw.skill-install-lock.v1" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.hostname !== "string" ||
    owner.hostname.length === 0
  ) {
    throw new InstallError("Installer lock has invalid identity", "LOCKED");
  }
  assertUuid(owner.nonce, "Installer lock nonce", "LOCKED");
  assertCanonicalUtcTimestamp(owner.started_at, "Installer lock timestamp", "LOCKED");
}

async function readLockOwner(paths, code = "LOCKED") {
  await assertSafeStateDirectory(paths.lock, "Installer lock directory", code);
  const entries = await readdir(paths.lock, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0].name !== "owner.json" ||
    !entries[0].isFile() ||
    entries[0].isSymbolicLink()
  ) {
    throw new InstallError("Installer lock directory has unexpected entries", code);
  }
  const owner = await readSafeStateJson(
    join(paths.lock, "owner.json"),
    "Installer lock owner",
    code,
  );
  validateLockOwner(owner);
  return owner;
}

async function acquireLock(paths, timestamp) {
  const owner = {
    schema_version: "cyborgclaw.skill-install-lock.v1",
    nonce: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    started_at: timestamp,
  };
  while (true) {
    try {
      await mkdir(paths.lock, { mode: 0o700 });
      await writeExclusiveStateFile(join(paths.lock, "owner.json"), Buffer.from(prettyJson(owner)));
      await fsyncDirectory(paths.state);
      return owner;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      let existing;
      try {
        existing = await readLockOwner(paths);
      } catch {
        throw new InstallError("Installer lock exists but cannot be authenticated", "LOCKED");
      }
      if (
        typeof existing.pid !== "number" ||
        typeof existing.nonce !== "string" ||
        existing.hostname !== hostname() ||
        pidIsLive(existing.pid)
      ) {
        throw new InstallError("Another installer owns the target", "LOCKED");
      }
      const stale = join(paths.state, `stale-lock-${existing.nonce}-${randomUUID()}`);
      try {
        await rename(paths.lock, stale);
        await fsyncDirectory(paths.state);
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") {
          throw renameError;
        }
      }
    }
  }
}

async function releaseLock(paths, owner) {
  const current = await readLockOwner(paths, "LOCK_OWNERSHIP_LOST");
  if (current.nonce !== owner.nonce) {
    throw new InstallError("Refusing to release a foreign lock", "LOCK_OWNERSHIP_LOST");
  }
  await unlink(join(paths.lock, "owner.json"));
  await rmdir(paths.lock);
  await fsyncDirectory(paths.state);
}

function validateReceiptShape(receipt, receiptId = receipt?.receipt_id) {
  const code = "INVALID_RECEIPT";
  assertExactKeys(
    receipt,
    [
      "schema_version",
      "receipt_id",
      "action",
      "skill_name",
      "installed_version",
      "source_path",
      "target_root",
      "target_path",
      "source_inventory_digest",
      "stage_inventory_digest",
      "installed_inventory_digest",
      "source_entry_count",
      "prior_inventory_digest",
      "backup_id",
      "backup_inventory_digest",
      "selected_rollback_receipt_id",
      "manifest_sha256",
      "provenance_sha256",
      "inventory_algorithm",
      "installer_algorithm",
      "node_version",
      "transaction_started_at",
      "transaction_completed_at",
      "equality",
      "claim_boundary",
    ],
    "Installation receipt",
    code,
  );
  if (
    receipt.schema_version !== receiptSchema ||
    receipt.receipt_id !== receiptId ||
    receipt.skill_name !== skillName ||
    !["install", "update", "rollback", "adopt"].includes(receipt.action)
  ) {
    throw new InstallError(`Receipt ${receiptId} has invalid identity`, code);
  }
  assertUuid(receipt.receipt_id, "Receipt ID", code);
  parseVersion(receipt.installed_version, code);
  for (const [label, path] of [
    ["Receipt source path", receipt.source_path],
    ["Receipt target root", receipt.target_root],
    ["Receipt target path", receipt.target_path],
  ]) {
    if (typeof path !== "string" || resolve(path) !== path) {
      throw new InstallError(`${label} must be an absolute normalized path`, code);
    }
  }
  for (const [label, digest, nullable] of [
    ["Receipt source inventory digest", receipt.source_inventory_digest, false],
    ["Receipt stage inventory digest", receipt.stage_inventory_digest, false],
    ["Receipt installed inventory digest", receipt.installed_inventory_digest, false],
    ["Receipt prior inventory digest", receipt.prior_inventory_digest, true],
    ["Receipt backup inventory digest", receipt.backup_inventory_digest, true],
    ["Receipt manifest digest", receipt.manifest_sha256, false],
    ["Receipt provenance digest", receipt.provenance_sha256, false],
  ]) {
    assertSha256(digest, label, { nullable, code });
  }
  if (!Number.isSafeInteger(receipt.source_entry_count) || receipt.source_entry_count <= 0) {
    throw new InstallError("Receipt source entry count is invalid", code);
  }
  if (receipt.backup_id !== null) {
    assertUuid(receipt.backup_id, "Receipt backup ID", code);
  }
  if (receipt.selected_rollback_receipt_id !== null) {
    assertUuid(receipt.selected_rollback_receipt_id, "Selected rollback receipt ID", code);
  }
  const hasPrior = receipt.prior_inventory_digest !== null;
  if (
    (hasPrior && receipt.backup_id !== receipt.receipt_id) ||
    (hasPrior && receipt.backup_inventory_digest !== receipt.prior_inventory_digest) ||
    (!hasPrior && (receipt.backup_id !== null || receipt.backup_inventory_digest !== null)) ||
    (receipt.action === "rollback") !== (receipt.selected_rollback_receipt_id !== null) ||
    (["install", "adopt"].includes(receipt.action) && hasPrior) ||
    (["update", "rollback"].includes(receipt.action) && !hasPrior)
  ) {
    throw new InstallError("Receipt backup or action linkage is invalid", code);
  }
  if (
    receipt.source_inventory_digest !== receipt.stage_inventory_digest ||
    receipt.source_inventory_digest !== receipt.installed_inventory_digest ||
    receipt.inventory_algorithm !== "cyborgclaw.logical-tree-inventory.v1" ||
    receipt.installer_algorithm !== "cyborgclaw.skill-installer.v1" ||
    typeof receipt.node_version !== "string" ||
    receipt.node_version.length === 0 ||
    receipt.claim_boundary !== receiptClaimBoundary
  ) {
    throw new InstallError("Receipt algorithm or equality identity is invalid", code);
  }
  assertExactKeys(
    receipt.equality,
    [
      "source_before_equals_stage",
      "source_before_equals_source_after",
      "source_before_equals_installed",
    ],
    "Receipt equality proof",
    code,
  );
  if (Object.values(receipt.equality).some((value) => value !== true)) {
    throw new InstallError("Receipt equality proof is incomplete", code);
  }
  assertCanonicalUtcTimestamp(receipt.transaction_started_at, "Receipt start timestamp", code);
  assertCanonicalUtcTimestamp(
    receipt.transaction_completed_at,
    "Receipt completion timestamp",
    code,
  );
  if (Date.parse(receipt.transaction_completed_at) < Date.parse(receipt.transaction_started_at)) {
    throw new InstallError("Receipt completion precedes its start", code);
  }
}

async function readVerifiedReceipt(paths, receiptId) {
  assertUuid(receiptId, "Receipt ID", "INVALID_RECEIPT");
  const receiptPath = join(paths.receipts, `${receiptId}.json`);
  const hashPath = join(paths.receipts, `${receiptId}.sha256`);
  const bytes = await readSafeStateFile(receiptPath, `Receipt ${receiptId}`, "INVALID_RECEIPT");
  const detachedBytes = await readSafeStateFile(
    hashPath,
    `Receipt ${receiptId} detached hash`,
    "INVALID_RECEIPT",
  );
  const detachedText = decodeStateText(
    detachedBytes,
    hashPath,
    `Receipt ${receiptId} detached hash`,
    "INVALID_RECEIPT",
  );
  if (!/^[0-9a-f]{64}\n$/.test(detachedText)) {
    throw new InstallError(`Receipt ${receiptId} has an invalid detached hash`, "INVALID_RECEIPT");
  }
  const detached = detachedText.slice(0, -1);
  if (detached !== sha256(bytes)) {
    throw new InstallError(
      `Receipt ${receiptId} failed detached hash verification`,
      "INVALID_RECEIPT",
    );
  }
  const receiptText = decodeStateText(
    bytes,
    receiptPath,
    `Receipt ${receiptId}`,
    "INVALID_RECEIPT",
  );
  const receipt = parseJsonStrict(receiptText, receiptPath);
  validateReceiptShape(receipt, receiptId);
  if (receiptText !== `${canonicalJson(receipt)}\n`) {
    throw new InstallError(`Receipt ${receiptId} is not canonically encoded`, "INVALID_RECEIPT");
  }
  return { receipt, digest: detached };
}

async function validateReceiptDirectory(paths) {
  const entries = await readdir(paths.receipts, { withFileTypes: true });
  const pairs = new Map();
  for (const entry of entries) {
    const match =
      /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(json|sha256)$/.exec(
        entry.name,
      );
    if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
      throw new InstallError(`Unsafe receipt directory entry: ${entry.name}`, "INVALID_RECEIPT");
    }
    const [, receiptId, extension] = match;
    const extensions = pairs.get(receiptId) ?? new Set();
    extensions.add(extension);
    pairs.set(receiptId, extensions);
  }
  for (const [receiptId, extensions] of pairs) {
    if (!extensions.has("json") || !extensions.has("sha256")) {
      throw new InstallError(`Receipt ${receiptId} is incomplete`, "INVALID_RECEIPT");
    }
    await readVerifiedReceipt(paths, receiptId);
  }
}

async function currentReceiptInfo(paths) {
  const pointerStatus = await lstatOptional(paths.current);
  if (pointerStatus === null) {
    return null;
  }
  if (!pointerStatus.isFile() || pointerStatus.isSymbolicLink()) {
    throw new InstallError("Current receipt pointer is unsafe", "INVALID_RECEIPT");
  }
  const pointer = await readSafeStateJson(
    paths.current,
    "Current receipt pointer",
    "INVALID_RECEIPT",
  );
  assertExactKeys(
    pointer,
    ["schema_version", "receipt_id", "receipt_sha256"],
    "Current receipt pointer",
    "INVALID_RECEIPT",
  );
  if (pointer.schema_version !== "cyborgclaw.skill-install-current.v1") {
    throw new InstallError("Current receipt pointer has an invalid schema", "INVALID_RECEIPT");
  }
  assertUuid(pointer.receipt_id, "Current receipt ID", "INVALID_RECEIPT");
  assertSha256(pointer.receipt_sha256, "Current receipt digest", { code: "INVALID_RECEIPT" });
  const verified = await readVerifiedReceipt(paths, pointer.receipt_id);
  if (verified.digest !== pointer.receipt_sha256) {
    throw new InstallError("Current pointer hash does not match its receipt", "INVALID_RECEIPT");
  }
  return { receipt: verified.receipt, digest: verified.digest };
}

async function currentReceipt(paths) {
  return (await currentReceiptInfo(paths))?.receipt ?? null;
}

async function writeReceipt(paths, receipt) {
  validateReceiptShape(receipt);
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`);
  const digest = sha256(bytes);
  const detachedBytes = Buffer.from(`${digest}\n`);
  const receiptPath = join(paths.receipts, `${receipt.receipt_id}.json`);
  const hashPath = join(paths.receipts, `${receipt.receipt_id}.sha256`);
  const receiptStatus = await lstatOptional(receiptPath);
  const hashStatus = await lstatOptional(hashPath);

  if (receiptStatus !== null) {
    const existingBytes = await readSafeStateFile(
      receiptPath,
      `Receipt ${receipt.receipt_id}`,
      "INVALID_RECEIPT",
    );
    if (!existingBytes.equals(bytes)) {
      throw new InstallError("Immutable receipt ID collision", "INVALID_RECEIPT");
    }
  }
  if (hashStatus !== null) {
    const existingHash = await readSafeStateFile(
      hashPath,
      `Receipt ${receipt.receipt_id} detached hash`,
      "INVALID_RECEIPT",
    );
    if (!existingHash.equals(detachedBytes)) {
      throw new InstallError("Immutable receipt hash collision", "INVALID_RECEIPT");
    }
  }
  if (receiptStatus === null) {
    await writeExclusiveStateFile(receiptPath, bytes);
  }
  if (hashStatus === null) {
    await writeExclusiveStateFile(hashPath, detachedBytes);
  }
  await fsyncDirectory(paths.receipts);
  const verified = await readVerifiedReceipt(paths, receipt.receipt_id);
  if (verified.digest !== digest || canonicalJson(verified.receipt) !== canonicalJson(receipt)) {
    throw new InstallError("Immutable receipt verification failed", "INVALID_RECEIPT");
  }
  await writeAtomicJson(paths.current, {
    schema_version: "cyborgclaw.skill-install-current.v1",
    receipt_id: receipt.receipt_id,
    receipt_sha256: digest,
  });
  return digest;
}

async function validateJournalIdentity(paths, target, journal, journalPath) {
  const code = "AMBIGUOUS_RECOVERY";
  assertExactKeys(
    journal,
    [
      "schema_version",
      "transaction_id",
      "skill_name",
      "phase",
      "action",
      "target_path",
      "stage_path",
      "backup_path",
      "old_inventory_digest",
      "new_inventory_digest",
      "prior_receipt_id",
      "prior_receipt_sha256",
      "receipt",
    ],
    "Installation journal",
    code,
  );
  try {
    assertUuid(journal.transaction_id, "Journal transaction ID");
  } catch {
    throw new InstallError("Journal transaction ID is invalid", code);
  }
  const expectedJournal = join(paths.journals, `${journal.transaction_id}.json`);
  const expectedStage = join(paths.stages, journal.transaction_id);
  const expectedBackup =
    journal.old_inventory_digest === null ? null : join(paths.backups, journal.transaction_id);
  if (
    journal.schema_version !== journalSchema ||
    journal.skill_name !== skillName ||
    journal.target_path !== target ||
    journalPath !== expectedJournal ||
    journal.stage_path !== expectedStage ||
    journal.backup_path !== expectedBackup ||
    !isContained(paths.journals, journalPath) ||
    !isContained(paths.stages, journal.stage_path) ||
    (journal.backup_path !== null && !isContained(paths.backups, journal.backup_path)) ||
    !["install", "update", "rollback", "adopt"].includes(journal.action) ||
    ![
      "PREPARED",
      "STAGE_VERIFIED",
      "CUTOVER_INTENT",
      "OLD_MOVED",
      "NEW_ACTIVE",
      "RECEIPT_COMMITTED",
      "COMPLETE",
      "RESTORED",
      "ABANDONED",
    ].includes(journal.phase)
  ) {
    throw new InstallError("Journal identity or path linkage is invalid", code);
  }
  assertSha256(journal.old_inventory_digest, "Journal old inventory digest", {
    nullable: true,
    code,
  });
  assertSha256(journal.new_inventory_digest, "Journal new inventory digest", { code });
  assertSha256(journal.prior_receipt_sha256, "Journal prior receipt digest", {
    nullable: true,
    code,
  });
  if (journal.prior_receipt_id !== null) {
    try {
      assertUuid(journal.prior_receipt_id, "Journal prior receipt ID", code);
    } catch {
      throw new InstallError("Journal prior receipt ID is invalid", code);
    }
  }
  if (
    (["install", "adopt"].includes(journal.action) && journal.old_inventory_digest !== null) ||
    (["update", "rollback"].includes(journal.action) && journal.old_inventory_digest === null) ||
    (journal.old_inventory_digest === null &&
      (journal.prior_receipt_id !== null || journal.prior_receipt_sha256 !== null)) ||
    (journal.old_inventory_digest !== null &&
      (journal.prior_receipt_id === null || journal.prior_receipt_sha256 === null))
  ) {
    throw new InstallError("Journal action and prior inventory do not agree", code);
  }
  try {
    validateReceiptShape(journal.receipt, journal.transaction_id);
  } catch (error) {
    throw new InstallError(`Journal embeds an invalid receipt: ${error.message}`, code);
  }
  if (
    journal.receipt.action !== journal.action ||
    journal.receipt.target_path !== target ||
    journal.receipt.target_root !== dirname(target) ||
    journal.receipt.source_inventory_digest !== journal.new_inventory_digest ||
    journal.receipt.stage_inventory_digest !== journal.new_inventory_digest ||
    journal.receipt.installed_inventory_digest !== journal.new_inventory_digest ||
    journal.receipt.prior_inventory_digest !== journal.old_inventory_digest ||
    journal.receipt.backup_inventory_digest !== journal.old_inventory_digest ||
    journal.receipt.backup_id !==
      (journal.old_inventory_digest === null ? null : journal.transaction_id)
  ) {
    throw new InstallError("Journal and receipt digests or paths do not agree", code);
  }
  if (
    journal.action === "rollback" &&
    journal.receipt.source_path !==
      join(paths.backups, journal.receipt.selected_rollback_receipt_id)
  ) {
    throw new InstallError("Rollback journal source path is not receipt-bound", code);
  }
  await assertNoSymlinkAncestors(journalPath);
  await assertNoSymlinkAncestors(journal.stage_path);
  if (journal.backup_path !== null) {
    await assertNoSymlinkAncestors(journal.backup_path);
  }
  if (journal.prior_receipt_id !== null) {
    let prior;
    try {
      prior = await readVerifiedReceipt(paths, journal.prior_receipt_id);
    } catch (error) {
      throw new InstallError(`Journal prior receipt is invalid: ${error.message}`, code);
    }
    if (
      prior.digest !== journal.prior_receipt_sha256 ||
      prior.receipt.target_path !== target ||
      prior.receipt.installed_inventory_digest !== journal.old_inventory_digest
    ) {
      throw new InstallError("Journal prior receipt does not bind the old target", code);
    }
  }
}

async function writeJournal(paths, journal) {
  const journalPath = join(paths.journals, `${journal.transaction_id}.json`);
  await validateJournalIdentity(paths, journal.target_path, journal, journalPath);
  await writeAtomicJson(journalPath, journal);
}

async function setPhase(paths, journal, phase) {
  journal.phase = phase;
  await writeJournal(paths, journal);
}

async function inventoryOptional(path) {
  await assertNoSymlinkAncestors(path);
  const status = await lstatOptional(path);
  if (status === null) {
    return null;
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new InstallError(`Expected an absent path or real directory: ${path}`, "INVALID_STATE");
  }
  return inventoryTree(path);
}

async function inspectExisting(target, paths) {
  const status = await lstatOptional(target);
  const receiptInfo = await currentReceiptInfo(paths);
  if (status === null) {
    return {
      status: null,
      inventory: null,
      manifest: null,
      receipt: receiptInfo?.receipt ?? null,
      receiptDigest: receiptInfo?.digest ?? null,
    };
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new InstallError("Existing target is not a real directory", "UNKNOWN_TARGET");
  }
  const inventory = await inventoryTree(target);
  const manifest = await loadInstalledManifest(target);
  return {
    status,
    inventory,
    manifest,
    receipt: receiptInfo?.receipt ?? null,
    receiptDigest: receiptInfo?.digest ?? null,
  };
}

function verifyKnownExisting(existing, target) {
  if (existing.receipt === null) {
    throw new InstallError("A different existing target has no trusted receipt", "UNKNOWN_TARGET");
  }
  if (existing.inventory === null || existing.manifest === null) {
    throw new InstallError("Current receipt names a missing active target", "TARGET_DRIFT");
  }
  const manifestEntry = existing.inventory.entries.find((entry) => entry.path === "manifest.json");
  const provenanceEntry = existing.inventory.entries.find(
    (entry) => entry.path === "references/PROVENANCE.json",
  );
  if (
    existing.receipt.target_path !== target ||
    existing.receipt.target_root !== dirname(target) ||
    existing.receipt.installed_inventory_digest !== existing.inventory.digest ||
    existing.receipt.installed_version !== existing.manifest.version ||
    existing.receipt.source_entry_count !== existing.inventory.entry_count ||
    existing.receipt.manifest_sha256 !== manifestEntry?.sha256 ||
    existing.receipt.provenance_sha256 !== provenanceEntry?.sha256
  ) {
    throw new InstallError("Existing target drifted from its current receipt", "TARGET_DRIFT");
  }
}

function makeReceipt({
  transactionId,
  action,
  source,
  sourceInventory,
  target,
  targetRoot,
  manifest,
  previousInventory,
  timestamp,
  selectedReceiptId,
}) {
  const manifestEntry = sourceInventory.entries.find((entry) => entry.path === "manifest.json");
  const provenanceEntry = sourceInventory.entries.find(
    (entry) => entry.path === "references/PROVENANCE.json",
  );
  return {
    schema_version: receiptSchema,
    receipt_id: transactionId,
    action,
    skill_name: skillName,
    installed_version: manifest.version,
    source_path: source,
    target_root: targetRoot,
    target_path: target,
    source_inventory_digest: sourceInventory.digest,
    stage_inventory_digest: sourceInventory.digest,
    installed_inventory_digest: sourceInventory.digest,
    source_entry_count: sourceInventory.entry_count,
    prior_inventory_digest: previousInventory?.digest ?? null,
    backup_id: previousInventory === null ? null : transactionId,
    backup_inventory_digest: previousInventory?.digest ?? null,
    selected_rollback_receipt_id: selectedReceiptId,
    manifest_sha256: manifestEntry?.sha256 ?? null,
    provenance_sha256: provenanceEntry?.sha256 ?? null,
    inventory_algorithm: "cyborgclaw.logical-tree-inventory.v1",
    installer_algorithm: "cyborgclaw.skill-installer.v1",
    node_version: process.versions.node,
    transaction_started_at: timestamp,
    transaction_completed_at: timestamp,
    equality: {
      source_before_equals_stage: true,
      source_before_equals_source_after: true,
      source_before_equals_installed: true,
    },
    claim_boundary: receiptClaimBoundary,
  };
}

async function finalizeActive(paths, journal) {
  const installed = await inventoryOptional(journal.target_path);
  if (installed?.digest !== journal.new_inventory_digest) {
    throw new InstallError("Active target does not match the journal", "AMBIGUOUS_RECOVERY");
  }
  await writeReceipt(paths, journal.receipt);
  await setPhase(paths, journal, "RECEIPT_COMMITTED");
  await setPhase(paths, journal, "COMPLETE");
}

async function assertRecoverySourceUnchanged(paths, journal, sourceContext) {
  let source;
  if (journal.action === "rollback") {
    source = join(paths.backups, journal.receipt.selected_rollback_receipt_id);
  } else {
    if (
      sourceContext === null ||
      sourceContext.path !== journal.receipt.source_path ||
      sourceContext.inventory.digest !== journal.new_inventory_digest
    ) {
      throw new InstallError(
        "Recovery invocation does not match the journaled source",
        "SOURCE_DRIFT",
      );
    }
    source = sourceContext.path;
  }
  await assertNoSymlinkAncestors(source);
  let inventory;
  try {
    inventory = await inventoryTree(source);
  } catch (error) {
    throw new InstallError(`Recovery source is unsafe: ${error.message}`, "SOURCE_DRIFT");
  }
  if (inventory.digest !== journal.new_inventory_digest) {
    throw new InstallError("Recovery source changed after staging", "SOURCE_DRIFT");
  }
}

async function restorePriorReceiptPointer(paths, journal) {
  const current = await currentReceiptInfo(paths);
  if (journal.prior_receipt_id === null) {
    if (current === null) {
      return;
    }
    if (current.receipt.receipt_id !== journal.transaction_id) {
      throw new InstallError("Cannot remove an unrelated current receipt pointer", "INVALID_STATE");
    }
    await unlink(paths.current);
    await fsyncDirectory(paths.state);
    return;
  }
  const prior = await readVerifiedReceipt(paths, journal.prior_receipt_id);
  if (
    prior.digest !== journal.prior_receipt_sha256 ||
    prior.receipt.target_path !== journal.target_path ||
    prior.receipt.installed_inventory_digest !== journal.old_inventory_digest
  ) {
    throw new InstallError("Prior receipt no longer matches the restored target", "INVALID_STATE");
  }
  if (
    current !== null &&
    ![journal.transaction_id, journal.prior_receipt_id].includes(current.receipt.receipt_id)
  ) {
    throw new InstallError(
      "Refusing to replace an unrelated current receipt pointer",
      "INVALID_STATE",
    );
  }
  await writeAtomicJson(paths.current, {
    schema_version: "cyborgclaw.skill-install-current.v1",
    receipt_id: journal.prior_receipt_id,
    receipt_sha256: journal.prior_receipt_sha256,
  });
}

async function abandonRecoveryBeforeActivation(paths, target, journal, targetDigest, backupDigest) {
  if (targetDigest === null && backupDigest === journal.old_inventory_digest) {
    if (journal.old_inventory_digest === null) {
      await abandonPreparedStage(paths, journal);
      return;
    }
    await rename(journal.backup_path, target);
    await fsyncDirectory(paths.backups);
    await fsyncDirectory(dirname(target));
    await restorePriorReceiptPointer(paths, journal);
    await setPhase(paths, journal, "RESTORED");
    return;
  }
  if (targetDigest === journal.old_inventory_digest && backupDigest === null) {
    await abandonPreparedStage(paths, journal);
    await restorePriorReceiptPointer(paths, journal);
    return;
  }
  throw new InstallError("Source drift occurred in an ambiguous recovery state", "SOURCE_DRIFT");
}

async function recoverJournal(paths, target, journal, journalPath, sourceContext) {
  await validateJournalIdentity(paths, target, journal, journalPath);
  if (["COMPLETE", "RESTORED", "ABANDONED"].includes(journal.phase)) {
    return;
  }
  const targetInventory = await inventoryOptional(target);
  const stageInventory = await inventoryOptional(journal.stage_path);
  const backupInventory =
    journal.backup_path === null ? null : await inventoryOptional(journal.backup_path);
  const targetDigest = targetInventory?.digest ?? null;
  const stageDigest = stageInventory?.digest ?? null;
  const backupDigest = backupInventory?.digest ?? null;
  const oldDigest = journal.old_inventory_digest;
  const newDigest = journal.new_inventory_digest;

  if (targetDigest === newDigest && stageDigest === null) {
    if (oldDigest !== null && backupDigest !== oldDigest) {
      throw new InstallError("Recovery backup drifted", "AMBIGUOUS_RECOVERY");
    }
    try {
      await assertRecoverySourceUnchanged(paths, journal, sourceContext);
    } catch (error) {
      if (journal.action === "adopt") {
        await setPhase(paths, journal, "ABANDONED");
      } else {
        await restoreAfterActivation(paths, journal, dirname(target));
      }
      throw error;
    }
    await finalizeActive(paths, journal);
    return;
  }
  if (
    targetDigest === null &&
    stageDigest === newDigest &&
    (oldDigest === null || backupDigest === oldDigest)
  ) {
    try {
      await assertRecoverySourceUnchanged(paths, journal, sourceContext);
    } catch (error) {
      await abandonRecoveryBeforeActivation(paths, target, journal, targetDigest, backupDigest);
      throw error;
    }
    await rename(journal.stage_path, target);
    await fsyncDirectory(dirname(target));
    await setPhase(paths, journal, "NEW_ACTIVE");
    try {
      await assertRecoverySourceUnchanged(paths, journal, sourceContext);
    } catch (error) {
      await restoreAfterActivation(paths, journal, dirname(target));
      throw error;
    }
    await finalizeActive(paths, journal);
    return;
  }
  if (targetDigest === oldDigest && stageDigest === newDigest && backupDigest === null) {
    try {
      await assertRecoverySourceUnchanged(paths, journal, sourceContext);
    } catch (error) {
      await abandonRecoveryBeforeActivation(paths, target, journal, targetDigest, backupDigest);
      throw error;
    }
    if (oldDigest !== null) {
      await rename(target, journal.backup_path);
      await fsyncDirectory(dirname(target));
      await setPhase(paths, journal, "OLD_MOVED");
    }
    await rename(journal.stage_path, target);
    await fsyncDirectory(dirname(target));
    await setPhase(paths, journal, "NEW_ACTIVE");
    try {
      await assertRecoverySourceUnchanged(paths, journal, sourceContext);
    } catch (error) {
      await restoreAfterActivation(paths, journal, dirname(target));
      throw error;
    }
    await finalizeActive(paths, journal);
    return;
  }
  if (
    targetDigest === null &&
    stageDigest === null &&
    oldDigest !== null &&
    backupDigest === oldDigest
  ) {
    await rename(journal.backup_path, target);
    await fsyncDirectory(dirname(target));
    await setPhase(paths, journal, "RESTORED");
    return;
  }
  if (targetDigest === oldDigest && backupDigest === null && stageDigest !== newDigest) {
    if (stageDigest !== null) {
      const abandoned = join(paths.stages, `abandoned-${journal.transaction_id}-${randomUUID()}`);
      await rename(journal.stage_path, abandoned);
      await fsyncDirectory(paths.stages);
    }
    await setPhase(paths, journal, "ABANDONED");
    return;
  }
  throw new InstallError(
    `Ambiguous recovery state for ${journal.transaction_id}`,
    "AMBIGUOUS_RECOVERY",
  );
}

async function readJournals(paths, target) {
  const entries = await readdir(paths.journals, { withFileTypes: true });
  const journalNames = entries
    .map((entry) => {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(
          entry.name,
        )
      ) {
        throw new InstallError(
          `Unsafe journal directory entry: ${entry.name}`,
          "AMBIGUOUS_RECOVERY",
        );
      }
      return entry.name;
    })
    .sort();
  const journals = [];
  for (const name of journalNames) {
    const journalPath = join(paths.journals, name);
    const journal = await readSafeStateJson(
      journalPath,
      `Installation journal ${name}`,
      "AMBIGUOUS_RECOVERY",
    );
    await validateJournalIdentity(paths, target, journal, journalPath);
    journals.push({ journal, journalPath });
  }
  return journals;
}

async function recoverIncomplete(paths, target, sourceContext = null) {
  for (const { journal, journalPath } of await readJournals(paths, target)) {
    await recoverJournal(paths, target, journal, journalPath, sourceContext);
  }
}

async function assertTargetUnchanged(target, before) {
  const currentStatus = await lstatOptional(target);
  if (before.status === null) {
    if (currentStatus !== null) {
      throw new InstallError("Target appeared during installation", "TARGET_DRIFT");
    }
    return;
  }
  if (
    currentStatus === null ||
    currentStatus.dev !== before.status.dev ||
    currentStatus.ino !== before.status.ino
  ) {
    throw new InstallError("Target identity changed during installation", "TARGET_DRIFT");
  }
  const currentInventory = await inventoryTree(target);
  if (!inventoriesEqual(currentInventory, before.inventory)) {
    throw new InstallError("Target bytes changed during installation", "TARGET_DRIFT");
  }
}

async function abandonPreparedStage(paths, journal) {
  const stageStatus = await lstatOptional(journal.stage_path);
  if (stageStatus !== null) {
    if (!stageStatus.isDirectory() || stageStatus.isSymbolicLink()) {
      throw new InstallError("Unsafe stage cannot be quarantined", "AMBIGUOUS_RECOVERY");
    }
    const abandoned = join(paths.stages, `abandoned-${journal.transaction_id}-${randomUUID()}`);
    await rename(journal.stage_path, abandoned);
    await fsyncDirectory(paths.stages);
  }
  await setPhase(paths, journal, "ABANDONED");
}

async function restoreAfterActivation(paths, journal, targetRoot) {
  const targetStatus = await lstatOptional(journal.target_path);
  if (targetStatus === null || !targetStatus.isDirectory() || targetStatus.isSymbolicLink()) {
    throw new InstallError("Activated target cannot be safely preserved", "AMBIGUOUS_RECOVERY");
  }
  let preservedPath = journal.stage_path;
  let activeInventory = null;
  try {
    activeInventory = await inventoryTree(journal.target_path);
  } catch {
    preservedPath = join(
      paths.stages,
      `abandoned-active-${journal.transaction_id}-${randomUUID()}`,
    );
  }
  if (activeInventory !== null && activeInventory.digest !== journal.new_inventory_digest) {
    preservedPath = join(
      paths.stages,
      `abandoned-active-${journal.transaction_id}-${randomUUID()}`,
    );
  }
  if ((await lstatOptional(preservedPath)) !== null) {
    throw new InstallError("Recovery preservation path already exists", "AMBIGUOUS_RECOVERY");
  }
  await rename(journal.target_path, preservedPath);
  await fsyncDirectory(targetRoot);
  await fsyncDirectory(paths.stages);
  if (journal.backup_path !== null) {
    const backupInventory = await inventoryOptional(journal.backup_path);
    if (backupInventory?.digest !== journal.old_inventory_digest) {
      throw new InstallError("Cannot restore a drifted backup", "AMBIGUOUS_RECOVERY");
    }
    await rename(journal.backup_path, journal.target_path);
    await fsyncDirectory(paths.backups);
    await fsyncDirectory(targetRoot);
    const restored = await inventoryTree(journal.target_path);
    if (restored.digest !== journal.old_inventory_digest) {
      throw new InstallError("Restored target differs from the old tree", "AMBIGUOUS_RECOVERY");
    }
    await restorePriorReceiptPointer(paths, journal);
    await setPhase(paths, journal, "RESTORED");
  } else {
    await restorePriorReceiptPointer(paths, journal);
    await setPhase(paths, journal, "ABANDONED");
  }
}

async function transact({
  source,
  sourceInventory,
  target,
  targetRoot,
  paths,
  existing,
  manifest,
  action,
  timestamp,
  selectedReceiptId = null,
}) {
  const transactionId = randomUUID();
  const stagePath = join(paths.stages, transactionId);
  const backupPath = existing.inventory === null ? null : join(paths.backups, transactionId);
  const receipt = makeReceipt({
    transactionId,
    action,
    source,
    sourceInventory,
    target,
    targetRoot,
    manifest,
    previousInventory: existing.inventory,
    timestamp,
    selectedReceiptId,
  });
  const journal = {
    schema_version: journalSchema,
    transaction_id: transactionId,
    skill_name: skillName,
    phase: "PREPARED",
    action,
    target_path: target,
    stage_path: stagePath,
    backup_path: backupPath,
    old_inventory_digest: existing.inventory?.digest ?? null,
    new_inventory_digest: sourceInventory.digest,
    prior_receipt_id: existing.receipt?.receipt_id ?? null,
    prior_receipt_sha256: existing.receiptDigest ?? null,
    receipt,
  };
  await writeJournal(paths, journal);
  await copyInventory(source, stagePath, sourceInventory);
  let stageInventory;
  let sourceAfter;
  try {
    stageInventory = await inventoryTree(stagePath);
    sourceAfter = await inventoryTree(source);
  } catch (error) {
    await abandonPreparedStage(paths, journal);
    throw new InstallError(
      `Source or stage became unsafe during copy: ${error.message}`,
      "SOURCE_DRIFT",
    );
  }
  if (
    !inventoriesEqual(sourceInventory, stageInventory) ||
    !inventoriesEqual(sourceInventory, sourceAfter)
  ) {
    await abandonPreparedStage(paths, journal);
    throw new InstallError("Source or stage changed during copy", "SOURCE_DRIFT");
  }
  await setPhase(paths, journal, "STAGE_VERIFIED");
  await assertTargetUnchanged(target, existing);
  await setPhase(paths, journal, "CUTOVER_INTENT");
  let sourceImmediatelyBeforeActivation;
  try {
    sourceImmediatelyBeforeActivation = await inventoryTree(source);
  } catch (error) {
    await abandonPreparedStage(paths, journal);
    throw new InstallError(
      `Source became unsafe immediately before activation: ${error.message}`,
      "SOURCE_DRIFT",
    );
  }
  if (!inventoriesEqual(sourceInventory, sourceImmediatelyBeforeActivation)) {
    await abandonPreparedStage(paths, journal);
    throw new InstallError("Source changed immediately before activation", "SOURCE_DRIFT");
  }

  if (existing.inventory !== null) {
    await rename(target, backupPath);
    await fsyncDirectory(targetRoot);
    await setPhase(paths, journal, "OLD_MOVED");
    const backupInventory = await inventoryTree(backupPath);
    if (!inventoriesEqual(backupInventory, existing.inventory)) {
      throw new InstallError("Backup differs from the pre-cutover target", "BACKUP_DRIFT");
    }
  }
  try {
    await rename(stagePath, target);
    await fsyncDirectory(targetRoot);
  } catch (error) {
    if (existing.inventory !== null && (await lstatOptional(target)) === null) {
      await rename(backupPath, target);
      await fsyncDirectory(targetRoot);
      await setPhase(paths, journal, "RESTORED");
    }
    throw error;
  }
  await setPhase(paths, journal, "NEW_ACTIVE");
  let sourceImmediatelyAfterActivation;
  try {
    sourceImmediatelyAfterActivation = await inventoryTree(source);
  } catch (error) {
    await restoreAfterActivation(paths, journal, targetRoot);
    throw new InstallError(
      `Source became unsafe immediately after activation: ${error.message}`,
      "SOURCE_DRIFT",
    );
  }
  if (!inventoriesEqual(sourceInventory, sourceImmediatelyAfterActivation)) {
    await restoreAfterActivation(paths, journal, targetRoot);
    throw new InstallError("Source changed immediately after activation", "SOURCE_DRIFT");
  }
  let installed;
  try {
    installed = await inventoryTree(target);
  } catch (error) {
    await restoreAfterActivation(paths, journal, targetRoot);
    throw new InstallError(
      `Installed tree became unsafe immediately after activation: ${error.message}`,
      "INSTALL_DRIFT",
    );
  }
  if (!inventoriesEqual(installed, sourceInventory)) {
    await restoreAfterActivation(paths, journal, targetRoot);
    throw new InstallError("Installed tree differs from its verified stage", "INSTALL_DRIFT");
  }
  await finalizeActive(paths, journal);
  return receipt;
}

async function adoptIdentical({
  source,
  sourceInventory,
  target,
  targetRoot,
  paths,
  existing,
  manifest,
  timestamp,
}) {
  await assertAdoptionStateEmpty(paths);
  const transactionId = randomUUID();
  const receipt = makeReceipt({
    transactionId,
    action: "adopt",
    source,
    sourceInventory,
    target,
    targetRoot,
    manifest,
    previousInventory: null,
    timestamp,
    selectedReceiptId: null,
  });
  const journal = {
    schema_version: journalSchema,
    transaction_id: transactionId,
    skill_name: skillName,
    phase: "NEW_ACTIVE",
    action: "adopt",
    target_path: target,
    stage_path: join(paths.stages, transactionId),
    backup_path: null,
    old_inventory_digest: null,
    new_inventory_digest: sourceInventory.digest,
    prior_receipt_id: null,
    prior_receipt_sha256: null,
    receipt,
  };
  await assertTargetUnchanged(target, existing);
  const sourceBefore = await inventoryTree(source);
  if (!inventoriesEqual(sourceBefore, sourceInventory)) {
    throw new InstallError("Source changed before identical-tree adoption", "SOURCE_DRIFT");
  }
  await writeJournal(paths, journal);
  let sourceAfter;
  try {
    sourceAfter = await inventoryTree(source);
    await assertTargetUnchanged(target, existing);
  } catch (error) {
    await setPhase(paths, journal, "ABANDONED");
    throw new InstallError(
      `Source or target became unsafe during identical-tree adoption: ${error.message}`,
      "SOURCE_DRIFT",
    );
  }
  if (!inventoriesEqual(sourceAfter, sourceInventory)) {
    await setPhase(paths, journal, "ABANDONED");
    throw new InstallError("Source changed during identical-tree adoption", "SOURCE_DRIFT");
  }
  await finalizeActive(paths, journal);
  return receipt;
}

async function assertAdoptionStateEmpty(paths) {
  for (const path of [paths.journals, paths.stages, paths.backups, paths.receipts]) {
    if ((await readdir(path)).length !== 0) {
      throw new InstallError(
        "Unmanaged identical target has non-empty installer custody state",
        "INVALID_STATE",
      );
    }
  }
  if ((await lstatOptional(paths.current)) !== null) {
    throw new InstallError(
      "Unmanaged identical target has an unexpected receipt pointer",
      "INVALID_STATE",
    );
  }
}

async function validateStateForDryRun(paths, target) {
  const stateStatus = await lstatOptional(paths.state);
  if (stateStatus === null) {
    return { present: false, receipt: null };
  }
  await validateStateLayout(paths);
  const lockStatus = await lstatOptional(paths.lock);
  if (lockStatus !== null) {
    await readLockOwner(paths);
    throw new InstallError("Installer state is locked; dry-run will not recover it", "LOCKED");
  }
  const journals = await readJournals(paths, target);
  const incomplete = journals.find(
    ({ journal }) => !["COMPLETE", "RESTORED", "ABANDONED"].includes(journal.phase),
  );
  if (incomplete) {
    throw new InstallError(
      `Transaction ${incomplete.journal.transaction_id} requires recovery`,
      "RECOVERY_REQUIRED",
    );
  }
  await validateReceiptDirectory(paths);
  const receiptInfo = await currentReceiptInfo(paths);
  const receipt = receiptInfo?.receipt ?? null;
  return { present: true, receipt, receiptDigest: receiptInfo?.digest ?? null };
}

async function dryRunInstall(options, source, sourceInventory, manifest, target, paths) {
  const targetStatus = await lstatOptional(target);
  const state = await validateStateForDryRun(paths, target);
  if (targetStatus === null) {
    if (state.receipt !== null) {
      throw new InstallError("Installer state names a missing active target", "TARGET_DRIFT");
    }
    return {
      dry_run: true,
      provisional: true,
      disposition: "INSTALL",
      source_inventory_digest: sourceInventory.digest,
      target,
    };
  }
  if (!targetStatus.isDirectory() || targetStatus.isSymbolicLink()) {
    throw new InstallError("Existing target is unsafe", "UNKNOWN_TARGET");
  }
  const existingInventory = await inventoryTree(target);
  if (inventoriesEqual(existingInventory, sourceInventory)) {
    const existingManifest = await loadInstalledManifest(target);
    const existing = {
      status: targetStatus,
      inventory: existingInventory,
      manifest: existingManifest,
      receipt: state.receipt,
      receiptDigest: state.receiptDigest ?? null,
    };
    if (state.receipt === null) {
      if (state.present) {
        await assertAdoptionStateEmpty(paths);
      }
      return {
        dry_run: true,
        provisional: true,
        disposition: "ADOPT_IDENTICAL",
        source_inventory_digest: sourceInventory.digest,
        target_inventory_digest: existingInventory.digest,
        target,
      };
    }
    verifyKnownExisting(existing, target);
    return {
      dry_run: true,
      provisional: true,
      disposition: "VERIFIED_NOOP",
      source_inventory_digest: sourceInventory.digest,
      target_inventory_digest: existingInventory.digest,
      target,
    };
  }
  if (!state.present) {
    throw new InstallError("Different target has no installer state", "UNKNOWN_TARGET");
  }
  const existing = {
    status: targetStatus,
    inventory: existingInventory,
    manifest: await loadInstalledManifest(target),
    receipt: state.receipt,
    receiptDigest: state.receiptDigest ?? null,
  };
  verifyKnownExisting(existing, target);
  const comparison = compareVersions(manifest.version, existing.manifest.version);
  if (comparison <= 0) {
    throw new InstallError(
      comparison === 0
        ? "Same-version drift is not replaced automatically"
        : "Downgrade is not allowed",
      comparison === 0 ? "SAME_VERSION_DRIFT" : "DOWNGRADE_REFUSED",
    );
  }
  return {
    dry_run: true,
    provisional: true,
    disposition: "UPDATE_WITH_BACKUP",
    source_inventory_digest: sourceInventory.digest,
    prior_inventory_digest: existing.inventory.digest,
    target,
  };
}

async function install(options) {
  await assertNoSymlinkAncestors(options.source);
  const source = await realDirectory(options.source);
  if (basename(source) !== skillName) {
    throw new InstallError("Source basename is not the fixed skill name", "INVALID_SOURCE");
  }
  const manifest = await loadManifest(source);
  const sourceInventory = await inventoryTree(source);
  await verifyPayloadChecksums(source, sourceInventory);
  await assertNoSymlinkAncestors(options.targetRoot);
  const target = join(options.targetRoot, skillName);
  if (!isContained(options.targetRoot, target)) {
    throw new InstallError("Target escaped target root", "UNSAFE_PATH");
  }
  if (isContained(source, target) || isContained(target, source)) {
    throw new InstallError("Source and target trees overlap", "UNSAFE_PATH");
  }
  const paths = statePaths(options.targetRoot);
  if (options.dryRun) {
    return dryRunInstall(options, source, sourceInventory, manifest, target, paths);
  }
  const rootStatus = await lstatOptional(options.targetRoot);
  if (rootStatus === null) {
    await mkdir(options.targetRoot, { recursive: true, mode: 0o755 });
  }
  const targetRoot = await realDirectory(options.targetRoot);
  const realTarget = join(targetRoot, skillName);
  const realPaths = statePaths(targetRoot);
  await initializeState(realPaths);
  const owner = await acquireLock(realPaths, options.timestamp);
  try {
    await recoverIncomplete(realPaths, realTarget, {
      path: source,
      inventory: sourceInventory,
    });
    await validateReceiptDirectory(realPaths);
    const existing = await inspectExisting(realTarget, realPaths);
    if (existing.inventory === null && existing.receipt !== null) {
      throw new InstallError("Current receipt names a missing active target", "TARGET_DRIFT");
    }
    if (existing.inventory !== null && inventoriesEqual(existing.inventory, sourceInventory)) {
      if (existing.receipt === null) {
        const receipt = await adoptIdentical({
          source,
          sourceInventory,
          target: realTarget,
          targetRoot,
          paths: realPaths,
          existing,
          manifest,
          timestamp: options.timestamp,
        });
        return {
          disposition: "ADOPTED_IDENTICAL",
          receipt_id: receipt.receipt_id,
          source_inventory_digest: sourceInventory.digest,
          installed_inventory_digest: existing.inventory.digest,
          exact_identity: true,
          backup_id: null,
          target: realTarget,
        };
      }
      verifyKnownExisting(existing, realTarget);
      const sourceNow = await inventoryTree(source);
      const installedNow = await inventoryTree(realTarget);
      if (
        !inventoriesEqual(sourceInventory, sourceNow) ||
        !inventoriesEqual(sourceInventory, installedNow)
      ) {
        throw new InstallError("Source or target drifted before verified no-op", "SOURCE_DRIFT");
      }
      return {
        disposition: "VERIFIED_NOOP",
        source_inventory_digest: sourceInventory.digest,
        installed_inventory_digest: existing.inventory.digest,
        target: realTarget,
      };
    }
    if (existing.inventory !== null) {
      verifyKnownExisting(existing, realTarget);
      const comparison = compareVersions(manifest.version, existing.manifest.version);
      if (comparison <= 0) {
        throw new InstallError(
          comparison === 0
            ? "Same-version drift is not replaced automatically"
            : "Downgrade is not allowed",
          comparison === 0 ? "SAME_VERSION_DRIFT" : "DOWNGRADE_REFUSED",
        );
      }
    }
    const receipt = await transact({
      source,
      sourceInventory,
      target: realTarget,
      targetRoot,
      paths: realPaths,
      existing,
      manifest,
      action: existing.inventory === null ? "install" : "update",
      timestamp: options.timestamp,
    });
    const installedInventory = await inventoryTree(realTarget);
    return {
      disposition: existing.inventory === null ? "INSTALLED" : "UPDATED",
      receipt_id: receipt.receipt_id,
      source_inventory_digest: sourceInventory.digest,
      installed_inventory_digest: installedInventory.digest,
      exact_identity: inventoriesEqual(sourceInventory, installedInventory),
      backup_id: receipt.backup_id,
      target: realTarget,
    };
  } finally {
    await releaseLock(realPaths, owner);
  }
}

async function rollback(options) {
  await assertNoSymlinkAncestors(options.targetRoot);
  const targetRootStatus = await lstatOptional(options.targetRoot);
  if (targetRootStatus === null) {
    throw new InstallError("Target root does not exist", "UNKNOWN_TARGET");
  }
  const targetRoot = await realDirectory(options.targetRoot);
  const target = join(targetRoot, skillName);
  const paths = statePaths(targetRoot);
  if ((await lstatOptional(paths.state)) === null) {
    throw new InstallError("Installer state does not exist", "UNKNOWN_TARGET");
  }
  await validateStateLayout(paths);
  if (options.dryRun) {
    await validateStateForDryRun(paths, target);
    const selected = await readVerifiedReceipt(paths, options.receiptId);
    const backupId = selected.receipt.backup_id;
    if (backupId === null) {
      throw new InstallError("Selected receipt has no prior-version backup", "NO_BACKUP");
    }
    const backup = join(paths.backups, backupId);
    await assertNoSymlinkAncestors(backup);
    const backupInventory = await inventoryTree(backup);
    if (backupInventory.digest !== selected.receipt.backup_inventory_digest) {
      throw new InstallError("Selected backup drifted from its receipt", "BACKUP_DRIFT");
    }
    const existing = await inspectExisting(target, paths);
    verifyKnownExisting(existing, target);
    return {
      dry_run: true,
      provisional: true,
      disposition: "ROLLBACK_WITH_CURRENT_BACKUP",
      selected_receipt_id: options.receiptId,
      backup_inventory_digest: backupInventory.digest,
      current_inventory_digest: existing.inventory.digest,
      target,
    };
  }
  const owner = await acquireLock(paths, options.timestamp);
  try {
    await recoverIncomplete(paths, target);
    await validateReceiptDirectory(paths);
    const selected = await readVerifiedReceipt(paths, options.receiptId);
    const backupId = selected.receipt.backup_id;
    if (backupId === null) {
      throw new InstallError("Selected receipt has no prior-version backup", "NO_BACKUP");
    }
    const backup = join(paths.backups, backupId);
    await assertNoSymlinkAncestors(backup);
    const backupInventory = await inventoryTree(backup);
    if (backupInventory.digest !== selected.receipt.backup_inventory_digest) {
      throw new InstallError("Selected backup drifted from its receipt", "BACKUP_DRIFT");
    }
    const manifest = await loadInstalledManifest(backup);
    const existing = await inspectExisting(target, paths);
    verifyKnownExisting(existing, target);
    const receipt = await transact({
      source: backup,
      sourceInventory: backupInventory,
      target,
      targetRoot,
      paths,
      existing,
      manifest,
      action: "rollback",
      timestamp: options.timestamp,
      selectedReceiptId: options.receiptId,
    });
    return {
      disposition: "ROLLED_BACK",
      receipt_id: receipt.receipt_id,
      selected_receipt_id: options.receiptId,
      installed_inventory_digest: backupInventory.digest,
      backup_of_replaced_current: receipt.backup_id,
      target,
    };
  } finally {
    await releaseLock(paths, owner);
  }
}

const usage = `Usage:
  node scripts/install.mjs install [--source DIR] [--target-root DIR] [--timestamp ISO] [--dry-run]
  node scripts/install.mjs rollback --target-root DIR --receipt-id UUID [--timestamp ISO] [--dry-run]
`;

try {
  const options = parseArguments(process.argv.slice(2));
  const result = options.command === "install" ? await install(options) : await rollback(options);
  process.stdout.write(`${prettyJson({ ok: true, ...result })}`);
} catch (error) {
  process.stderr.write(
    `${prettyJson({
      ok: false,
      code: error instanceof InstallError ? error.code : (error.code ?? "UNEXPECTED_ERROR"),
      error: error.message,
    })}`,
  );
  if (error?.code === "USAGE") {
    process.stderr.write(usage);
  }
  process.exitCode = 1;
}
