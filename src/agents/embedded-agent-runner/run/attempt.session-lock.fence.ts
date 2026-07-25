import { createHash } from "node:crypto";
import { type BigIntStats, statSync } from "node:fs";
import fs from "node:fs/promises";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { parseSqliteSessionFileMarker } from "../../../config/sessions/sqlite-marker.js";
import type { OwnedSessionTranscriptPublishedEntry } from "../../../config/sessions/transcript-write-context.js";
import {
  classifyPromptReleasedSessionLines,
  lineMatchesLinearTranscriptMigration,
  type PromptReleasedSessionChange,
} from "./attempt.session-lock.entries.js";

export type SessionFileFingerprint =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
    };

export type TrustedSessionFileSnapshot = Extract<SessionFileFingerprint, { exists: true }>;

const MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES = 1024 * 1024;
const MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES = 8 * 1024 * 1024;
const MAX_BENIGN_SESSION_FENCE_REWRITE_RESULT_BYTES =
  MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES + MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES;
const MAX_BENIGN_SESSION_FENCE_CONTENT_DIGEST_BYTES = 32 * 1024 * 1024;
const MAX_SAFE_FILE_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);

export type SessionFileFenceSnapshot = {
  fingerprint: SessionFileFingerprint;
  bytes?: Buffer;
  digest?: string;
};

type SessionFileHandle = Awaited<ReturnType<typeof fs.open>>;

function sessionFileFingerprintFromStat(stat: BigIntStats): SessionFileFingerprint {
  return {
    exists: true,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

export function sameSessionFileFingerprint(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  if (!left || left.exists !== right.exists) {
    return false;
  }
  if (!left.exists || !right.exists) {
    return true;
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameSessionFileIdentity(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  return Boolean(left?.exists && right.exists && left.dev === right.dev && left.ino === right.ino);
}

function sameSessionFileIdentityAndSize(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  return Boolean(
    left?.exists &&
    right.exists &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size,
  );
}

function splitSessionFileLines(text: string): string[] {
  return normalizeStringEntries(text.split(/\r?\n/));
}

async function readAppendedSessionFileText(params: {
  sessionFile: string;
  previous: Extract<SessionFileFingerprint, { exists: true }>;
  current: Extract<SessionFileFingerprint, { exists: true }>;
  maxBytes?: number;
}): Promise<string | undefined> {
  if (params.current.size <= params.previous.size || params.previous.size > MAX_SAFE_FILE_OFFSET) {
    return undefined;
  }
  const appendedBytes = params.current.size - params.previous.size;
  if (
    (params.maxBytes !== undefined && appendedBytes > BigInt(params.maxBytes)) ||
    appendedBytes > MAX_SAFE_FILE_OFFSET
  ) {
    return undefined;
  }
  const length = Number(appendedBytes);
  const buffer = Buffer.alloc(length);
  const file = await fs.open(params.sessionFile, "r");
  try {
    const { bytesRead } = await file.read(buffer, 0, length, Number(params.previous.size));
    if (bytesRead !== length) {
      return undefined;
    }
  } finally {
    await file.close();
  }
  return buffer.toString("utf8");
}

export async function readSessionFileFenceSnapshot(
  sessionFile: string,
): Promise<SessionFileFenceSnapshot> {
  const fingerprint = await readSessionFileFingerprint(sessionFile);
  if (!fingerprint.exists) {
    return { fingerprint };
  }
  if (fingerprint.size > BigInt(MAX_BENIGN_SESSION_FENCE_CONTENT_DIGEST_BYTES)) {
    return { fingerprint };
  }
  let file: SessionFileHandle;
  try {
    file = await fs.open(sessionFile, "r");
  } catch {
    return { fingerprint };
  }
  try {
    const openedFingerprint = sessionFileFingerprintFromStat(await file.stat({ bigint: true }));
    if (!sameSessionFileIdentityAndSize(fingerprint, openedFingerprint)) {
      return { fingerprint: await readSessionFileFingerprint(sessionFile) };
    }

    let bytes: Buffer | undefined;
    let digest: string | undefined;
    if (
      fingerprint.size <= BigInt(MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES) &&
      fingerprint.size <= MAX_SAFE_FILE_OFFSET
    ) {
      bytes = await readSessionFileBytes(file, Number(fingerprint.size));
    } else if (fingerprint.size <= BigInt(MAX_BENIGN_SESSION_FENCE_CONTENT_DIGEST_BYTES)) {
      digest = await readSessionFileDigest(file, Number(fingerprint.size));
    }

    const postReadFingerprint = sessionFileFingerprintFromStat(await file.stat({ bigint: true }));
    const resolvedFingerprint = await readSessionFileFingerprint(sessionFile);
    if (
      !sameSessionFileIdentityAndSize(openedFingerprint, postReadFingerprint) ||
      !sameSessionFileFingerprint(fingerprint, resolvedFingerprint) ||
      !sameSessionFileIdentityAndSize(postReadFingerprint, resolvedFingerprint)
    ) {
      return { fingerprint: resolvedFingerprint };
    }
    return {
      fingerprint: resolvedFingerprint,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(digest !== undefined ? { digest } : {}),
    };
  } catch {
    return { fingerprint: await readSessionFileFingerprint(sessionFile) };
  } finally {
    await file.close();
  }
}

async function readSessionFileBytes(
  file: SessionFileHandle,
  length: number,
): Promise<Buffer | undefined> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, offset);
    if (bytesRead === 0) {
      return undefined;
    }
    offset += bytesRead;
  }
  return buffer;
}

async function readSessionFileDigest(
  file: SessionFileHandle,
  length: number,
): Promise<string | undefined> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(length, 64 * 1024));
  let offset = 0;
  while (offset < length) {
    const nextLength = Math.min(buffer.length, length - offset);
    const { bytesRead } = await file.read(buffer, 0, nextLength, offset);
    if (bytesRead === 0) {
      return undefined;
    }
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

async function classifySessionFenceAdvance(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  allowAnyMessage?: boolean;
  expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
}): Promise<PromptReleasedSessionChange | undefined> {
  if (
    !params.previous?.fingerprint.exists ||
    !params.current.exists ||
    !sameSessionFileIdentity(params.previous.fingerprint, params.current)
  ) {
    return undefined;
  }
  const text = await readAppendedSessionFileText({
    sessionFile: params.sessionFile,
    previous: params.previous.fingerprint,
    current: params.current,
    // Exact IDs come from the lock owner. Replaying the persisted entry needs
    // its full payload, so only unowned benign classification uses the size cap.
    ...(params.allowAnyMessage ? {} : { maxBytes: MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES }),
  });
  if (!text?.endsWith("\n")) {
    return undefined;
  }
  const lines = normalizeStringEntries(text.split("\n"));
  return classifyPromptReleasedSessionLines(lines, params);
}

async function classifyOwnedSessionFileInitialization(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  expectedPublishedEntries: readonly OwnedSessionTranscriptPublishedEntry[];
}): Promise<PromptReleasedSessionChange | undefined> {
  if (
    !params.current.exists ||
    (params.previous?.fingerprint.exists === true && params.previous.fingerprint.size > 0n) ||
    params.current.size > MAX_SAFE_FILE_OFFSET
  ) {
    return undefined;
  }
  let text: string;
  try {
    text = await fs.readFile(params.sessionFile, "utf8");
  } catch {
    return undefined;
  }
  if (!text.endsWith("\n")) {
    return undefined;
  }
  const lines = normalizeStringEntries(text.split("\n"));
  const expectedHeader = params.expectedPublishedEntries.find((entry) => entry.kind === "header");
  if (expectedHeader) {
    if (lines[0] !== expectedHeader.serialized) {
      return undefined;
    }
    lines.shift();
  }
  const remainingExpectedEntries = expectedHeader
    ? params.expectedPublishedEntries.filter((entry) => entry !== expectedHeader)
    : params.expectedPublishedEntries;
  const change = classifyPromptReleasedSessionLines(lines, {
    allowAnyMessage: true,
    expectedPublishedEntries: remainingExpectedEntries,
  });
  if (!change && lines.length > 0) {
    return undefined;
  }
  const resolvedChange =
    change ??
    ({
      kind: "transcript-only",
      entries: [],
      publishedEntries: [],
    } satisfies PromptReleasedSessionChange);
  return expectedHeader
    ? {
        ...resolvedChange,
        publishedEntries: [expectedHeader, ...resolvedChange.publishedEntries],
      }
    : resolvedChange;
}

export async function readByteIdenticalSessionFenceSnapshot(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
}): Promise<SessionFileFenceSnapshot | undefined> {
  const previous = params.previous;
  if (
    previous?.fingerprint.exists !== true ||
    !params.current.exists ||
    !sameSessionFileIdentityAndSize(previous.fingerprint, params.current)
  ) {
    return undefined;
  }
  const verified = await readSessionFileFenceSnapshot(params.sessionFile);
  if (!sameSessionFileIdentityAndSize(params.current, verified.fingerprint)) {
    return undefined;
  }
  // Truncate-and-rewrite keeps inode and size while advancing timestamps.
  // Install only the stable snapshot whose exact bytes were compared here.
  if (previous.bytes !== undefined && verified.bytes !== undefined) {
    return previous.bytes.equals(verified.bytes) ? verified : undefined;
  }
  return previous.digest !== undefined && previous.digest === verified.digest
    ? verified
    : undefined;
}

async function classifySessionFenceRewrite(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  allowAnyMessage?: boolean;
  expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
}): Promise<PromptReleasedSessionChange | undefined> {
  if (
    !params.previous?.fingerprint.exists ||
    !params.current.exists ||
    params.previous.bytes === undefined ||
    !sameSessionFileIdentity(params.previous.fingerprint, params.current) ||
    (!params.allowAnyMessage &&
      params.current.size > BigInt(MAX_BENIGN_SESSION_FENCE_REWRITE_RESULT_BYTES)) ||
    params.current.size > MAX_SAFE_FILE_OFFSET
  ) {
    return undefined;
  }
  let currentText: string;
  try {
    currentText = await fs.readFile(params.sessionFile, "utf8");
  } catch {
    return undefined;
  }
  if (!currentText.endsWith("\n")) {
    return undefined;
  }
  const previousLines = splitSessionFileLines(params.previous.bytes.toString("utf8"));
  const currentLines = splitSessionFileLines(currentText);
  if (currentLines.length <= previousLines.length) {
    return undefined;
  }
  let expectedParentId: string | null = null;
  for (let index = 0; index < previousLines.length; index += 1) {
    const lineMatch = lineMatchesLinearTranscriptMigration({
      previousLine: previousLines[index] ?? "",
      currentLine: currentLines[index] ?? "",
      expectedParentId,
    });
    if (!lineMatch.ok) {
      return undefined;
    }
    expectedParentId = lineMatch.nextPreviousId ?? expectedParentId;
  }
  const appendedLines = currentLines.slice(previousLines.length);
  return classifyPromptReleasedSessionLines(appendedLines, {
    ...params,
    initialParentId: expectedParentId,
  });
}

export async function classifySessionFenceChange(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
  expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
}): Promise<PromptReleasedSessionChange | undefined> {
  const allowAnyMessage = params.expectedPublishedEntries !== undefined;
  return (
    (params.expectedPublishedEntries
      ? await classifyOwnedSessionFileInitialization({
          ...params,
          expectedPublishedEntries: params.expectedPublishedEntries,
        })
      : undefined) ??
    (await classifySessionFenceAdvance({ ...params, allowAnyMessage })) ??
    (await classifySessionFenceRewrite({ ...params, allowAnyMessage }))
  );
}

export async function readSessionFileFingerprint(
  sessionFile: string,
): Promise<SessionFileFingerprint> {
  if (parseSqliteSessionFileMarker(sessionFile)) {
    return { exists: false };
  }
  try {
    return sessionFileFingerprintFromStat(await fs.stat(sessionFile, { bigint: true }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

export function readSessionFileFingerprintSync(sessionFile: string): SessionFileFingerprint {
  if (parseSqliteSessionFileMarker(sessionFile)) {
    return { exists: false };
  }
  try {
    return sessionFileFingerprintFromStat(statSync(sessionFile, { bigint: true }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}
