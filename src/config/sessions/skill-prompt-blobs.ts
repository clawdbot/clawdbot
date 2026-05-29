import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeTextAtomic } from "../../infra/json-files.js";
import type { SessionEntry, SessionSkillPromptRef, SessionSkillSnapshot } from "./types.js";

const PROMPT_BLOB_DIR = "skills-prompts";
const PROMPT_BLOB_ALGORITHM: SessionSkillPromptRef["algorithm"] = "sha256";
const PROMPT_BLOB_VERSION: SessionSkillPromptRef["version"] = 1;
const MIN_PROMPT_BLOB_CHARS = 512;
const MAX_PROMPT_BLOB_BYTES = 512 * 1024;
const PROMPT_REF_CACHE_MAX_ENTRIES = 256;

type PersistedSessionStore = {
  store: Record<string, SessionEntry>;
  changed: boolean;
};

export type SessionSkillPromptBlobProjection = {
  ref: SessionSkillPromptRef;
  path: string | null;
  prompt: string;
};

export type SessionStorePersistenceProjection = PersistedSessionStore & {
  promptBlobs: Map<string, SessionSkillPromptBlobProjection>;
};

const promptRefCache = new Map<string, SessionSkillPromptRef>();

function hashPrompt(prompt: string): string {
  return crypto.createHash(PROMPT_BLOB_ALGORITHM).update(prompt).digest("hex");
}

export function clearSessionSkillPromptRefCache(): void {
  promptRefCache.clear();
}

export function getSessionSkillPromptRefCacheStatsForTest(): {
  entries: number;
  maxEntries: number;
} {
  return {
    entries: promptRefCache.size,
    maxEntries: PROMPT_REF_CACHE_MAX_ENTRIES,
  };
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

export function resolveSessionSkillPromptBlobPath(storePath: string, hash: string): string | null {
  if (!isSha256Hex(hash)) {
    return null;
  }
  return path.join(
    path.dirname(path.resolve(storePath)),
    PROMPT_BLOB_DIR,
    PROMPT_BLOB_ALGORITHM,
    hash.slice(0, 2),
    `${hash}.txt`,
  );
}

function buildPromptRef(prompt: string): SessionSkillPromptRef {
  const cached = promptRefCache.get(prompt);
  if (cached) {
    return cached;
  }
  const ref = {
    version: PROMPT_BLOB_VERSION,
    algorithm: PROMPT_BLOB_ALGORITHM,
    hash: hashPrompt(prompt),
    bytes: Buffer.byteLength(prompt, "utf8"),
  };
  promptRefCache.set(prompt, ref);
  while (promptRefCache.size > PROMPT_REF_CACHE_MAX_ENTRIES) {
    const oldest = promptRefCache.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    promptRefCache.delete(oldest);
  }
  return ref;
}

function shouldStorePromptAsBlob(prompt: string): boolean {
  const bytes = Buffer.byteLength(prompt, "utf8");
  return prompt.length >= MIN_PROMPT_BLOB_CHARS && bytes <= MAX_PROMPT_BLOB_BYTES;
}

function readValidPromptBlob(storePath: string, ref: SessionSkillPromptRef): string | null {
  if (
    ref.version !== PROMPT_BLOB_VERSION ||
    ref.algorithm !== PROMPT_BLOB_ALGORITHM ||
    !isSha256Hex(ref.hash) ||
    typeof ref.bytes !== "number" ||
    !Number.isFinite(ref.bytes) ||
    ref.bytes < 0 ||
    ref.bytes > MAX_PROMPT_BLOB_BYTES
  ) {
    return null;
  }
  const blobPath = resolveSessionSkillPromptBlobPath(storePath, ref.hash);
  if (!blobPath) {
    return null;
  }
  try {
    const stat = fs.statSync(blobPath);
    if (!stat.isFile() || stat.size !== ref.bytes) {
      return null;
    }
    const prompt = fs.readFileSync(blobPath, "utf8");
    return hashPrompt(prompt) === ref.hash && Buffer.byteLength(prompt, "utf8") === ref.bytes
      ? prompt
      : null;
  } catch {
    return null;
  }
}

async function ensurePromptBlob(storePath: string, prompt: string): Promise<SessionSkillPromptRef> {
  const ref = buildPromptRef(prompt);
  const blobPath = resolveSessionSkillPromptBlobPath(storePath, ref.hash);
  if (!blobPath) {
    return ref;
  }
  if (readValidPromptBlob(storePath, ref) === prompt) {
    try {
      const now = new Date();
      // Saving a store can reference an existing content-addressed blob before
      // sessions.json is replaced. Refresh its mtime so orphan cleanup does not
      // reclaim the blob while the store write is still in flight.
      await fs.promises.utimes(blobPath, now, now);
      return ref;
    } catch {
      // A concurrent cleanup may have removed it; rewrite below.
    }
  }
  await fs.promises.mkdir(path.dirname(blobPath), { recursive: true });
  await writeTextAtomic(blobPath, prompt, {
    durable: false,
    mode: 0o600,
    tempPrefix: path.basename(blobPath),
  });
  return ref;
}

function stripPromptForPersistence(entry: SessionEntry, ref: SessionSkillPromptRef): SessionEntry {
  const { prompt: _prompt, ...snapshot } = entry.skillsSnapshot!;
  return {
    ...entry,
    skillsSnapshot: {
      ...snapshot,
      promptRef: ref,
    } as SessionSkillSnapshot,
  };
}

export function projectSessionStoreForPersistence(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}): SessionStorePersistenceProjection {
  let persisted = params.store;
  let changed = false;
  const promptBlobs = new Map<string, SessionSkillPromptBlobProjection>();
  for (const [key, entry] of Object.entries(params.store)) {
    const prompt = entry.skillsSnapshot?.prompt;
    if (!prompt || !shouldStorePromptAsBlob(prompt)) {
      continue;
    }
    const promptRef = buildPromptRef(prompt);
    promptBlobs.set(promptRef.hash, {
      ref: promptRef,
      path: resolveSessionSkillPromptBlobPath(params.storePath, promptRef.hash),
      prompt,
    });
    if (persisted === params.store) {
      persisted = { ...params.store };
    }
    persisted[key] = stripPromptForPersistence(entry, promptRef);
    changed = true;
  }
  return { store: persisted, changed, promptBlobs };
}

export async function ensureSessionStorePromptBlobsForPersistence(params: {
  storePath: string;
  promptBlobs: Iterable<SessionSkillPromptBlobProjection>;
}): Promise<void> {
  for (const blob of params.promptBlobs) {
    await ensurePromptBlob(params.storePath, blob.prompt);
  }
}

function parsePromptRef(value: unknown): SessionSkillPromptRef | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const ref = value as Partial<SessionSkillPromptRef>;
  return ref.version === PROMPT_BLOB_VERSION &&
    ref.algorithm === PROMPT_BLOB_ALGORITHM &&
    typeof ref.hash === "string" &&
    typeof ref.bytes === "number"
    ? {
        version: ref.version,
        algorithm: ref.algorithm,
        hash: ref.hash,
        bytes: ref.bytes,
      }
    : null;
}

export function hydrateSessionStoreSkillPromptRefs(params: {
  storePath: string;
  store: Record<string, unknown>;
}): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(params.store)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const entry = value as SessionEntry;
    const snapshot = entry.skillsSnapshot;
    if (!snapshot || typeof snapshot.prompt === "string") {
      continue;
    }
    const promptRef = parsePromptRef((snapshot as { promptRef?: unknown }).promptRef);
    const prompt = promptRef ? readValidPromptBlob(params.storePath, promptRef) : null;
    if (!prompt) {
      const nextEntry = { ...entry };
      delete nextEntry.skillsSnapshot;
      params.store[key] = nextEntry;
      changed = true;
      continue;
    }
    const { promptRef: _promptRef, ...rest } = snapshot as typeof snapshot & {
      promptRef?: SessionSkillPromptRef;
    };
    params.store[key] = {
      ...entry,
      skillsSnapshot: {
        ...rest,
        prompt,
      },
    };
    changed = true;
  }
  return changed;
}
