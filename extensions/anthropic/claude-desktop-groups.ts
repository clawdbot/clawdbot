import fs from "node:fs/promises";
import path from "node:path";

const LEVELDB_FOOTER_BYTES = 48;
const LEVELDB_BLOCK_TRAILER_BYTES = 5;
const MAX_LEVELDB_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LEVELDB_FILES = 256;
const MAX_LEVELDB_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SNAPPY_BLOCK_BYTES = 16 * 1024 * 1024;

type ParsedGroups = {
  groups: Map<string, string>;
  assignments: Map<string, string>;
};

type LevelDbValue = {
  sequence: bigint;
  value: Uint8Array;
};

// Desktop spreads group state across more than one Local Storage key, and the key
// names are private to it. Select by record shape instead of key name so a rename
// degrades to "no groups" rather than silently wrong ones, and so only matching
// values are retained in memory. Accepted tradeoff: a deletion tombstone carries no
// records, so clearing Desktop's site data can leave stale labels until compaction.
const GROUP_RECORD_MARKER = /"code:local_[a-f0-9-]+":"cg-|"id":"cg-[a-f0-9-]+","name":"/i;

const LEVELDB_VALUE_KIND = 1;
const EMPTY_VALUE = new Uint8Array();

/**
 * Chromium stores a Local Storage value as UTF-16 whenever it holds a character that
 * Latin-1 cannot represent, so ASCII JSON arrives with interleaved NUL bytes. Dropping
 * them yields one scannable form for both encodings; without this a single emoji in any
 * group name hides every record in that value.
 */
function localStorageText(value: Uint8Array): string {
  return Buffer.from(value).toString("latin1").replaceAll("\0", "");
}

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[cursor];
    if (byte === undefined) {
      throw new Error("unexpected end of LevelDB varint");
    }
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return [value, cursor];
    }
    shift += 7;
  }
  throw new Error("invalid LevelDB varint");
}

function decodeSnappy(compressed: Uint8Array): Uint8Array {
  let offset = 0;
  const [expectedLength, afterLength] = readVarint(compressed, offset);
  offset = afterLength;
  if (expectedLength > MAX_SNAPPY_BLOCK_BYTES) {
    throw new Error("Claude Desktop LevelDB block is too large");
  }
  const output = new Uint8Array(expectedLength);
  let written = 0;
  while (offset < compressed.length) {
    const tag = compressed[offset];
    if (tag === undefined) {
      throw new Error("unexpected end of Snappy block");
    }
    offset += 1;
    const kind = tag & 0x03;
    if (kind === 0) {
      let length = tag >>> 2;
      if (length < 60) {
        length += 1;
      } else {
        const count = length - 59;
        if (offset + count > compressed.length) {
          throw new Error("invalid Snappy literal length");
        }
        length = 1;
        for (let index = 0; index < count; index += 1) {
          length += (compressed[offset + index] ?? 0) * 2 ** (8 * index);
        }
        offset += count;
      }
      if (offset + length > compressed.length || written + length > output.length) {
        throw new Error("invalid Snappy literal");
      }
      output.set(compressed.subarray(offset, offset + length), written);
      offset += length;
      written += length;
      continue;
    }
    let length: number;
    let copyOffset: number;
    if (kind === 1) {
      length = ((tag >>> 2) & 0x07) + 4;
      copyOffset = ((tag >>> 5) << 8) | (compressed[offset] ?? 0);
      offset += 1;
    } else if (kind === 2) {
      length = (tag >>> 2) + 1;
      copyOffset = (compressed[offset] ?? 0) | ((compressed[offset + 1] ?? 0) << 8);
      offset += 2;
    } else {
      length = (tag >>> 2) + 1;
      copyOffset =
        (compressed[offset] ?? 0) |
        ((compressed[offset + 1] ?? 0) << 8) |
        ((compressed[offset + 2] ?? 0) << 16) |
        ((compressed[offset + 3] ?? 0) << 24);
      offset += 4;
    }
    if (copyOffset <= 0 || copyOffset > written || written + length > output.length) {
      throw new Error("invalid Snappy copy offset");
    }
    for (let index = 0; index < length; index += 1) {
      output[written] = output[written - copyOffset] ?? 0;
      written += 1;
    }
  }
  if (written !== output.length) {
    throw new Error("incomplete Snappy block");
  }
  return output;
}

function readBlock(file: Uint8Array, offset: number, size: number): Uint8Array {
  const trailerOffset = offset + size;
  if (offset < 0 || size < 0 || trailerOffset + LEVELDB_BLOCK_TRAILER_BYTES > file.length) {
    throw new Error("invalid LevelDB block handle");
  }
  const block = file.subarray(offset, trailerOffset);
  switch (file[trailerOffset]) {
    case 0:
      return block;
    case 1:
      return decodeSnappy(block);
    default:
      throw new Error("unsupported LevelDB compression");
  }
}

function forEachLevelDbEntry(
  block: Uint8Array,
  visit: (key: Uint8Array, value: Uint8Array) => void,
): void {
  if (block.length < 4) {
    throw new Error("invalid LevelDB block");
  }
  const restartCount = new DataView(block.buffer, block.byteOffset + block.length - 4, 4).getUint32(
    0,
    true,
  );
  const entriesEnd = block.length - 4 - restartCount * 4;
  if (entriesEnd < 0) {
    throw new Error("invalid LevelDB restart array");
  }
  let offset = 0;
  let previousKey = new Uint8Array();
  while (offset < entriesEnd) {
    const [shared, afterShared] = readVarint(block, offset);
    const [unshared, afterUnshared] = readVarint(block, afterShared);
    const [valueLength, afterValueLength] = readVarint(block, afterUnshared);
    const keyEnd = afterValueLength + unshared;
    const valueEnd = keyEnd + valueLength;
    if (shared > previousKey.length || valueEnd > entriesEnd) {
      throw new Error("invalid LevelDB entry");
    }
    const key = new Uint8Array(shared + unshared);
    key.set(previousKey.subarray(0, shared));
    key.set(block.subarray(afterValueLength, keyEnd), shared);
    visit(key, block.subarray(keyEnd, valueEnd));
    previousKey = key;
    offset = valueEnd;
  }
}

function levelDbDataBlocks(file: Uint8Array): Uint8Array[] {
  if (file.length < LEVELDB_FOOTER_BYTES) {
    return [];
  }
  // Footer layout: metaindex handle (offset+size), then index handle (offset+size).
  const footer = file.subarray(file.length - LEVELDB_FOOTER_BYTES);
  const [, afterMetaindexOffset] = readVarint(footer, 0);
  const [, afterMetaindexHandle] = readVarint(footer, afterMetaindexOffset);
  const [indexOffset, afterIndexOffset] = readVarint(footer, afterMetaindexHandle);
  const [indexSize] = readVarint(footer, afterIndexOffset);
  const index = readBlock(file, indexOffset, indexSize);
  const blocks: Uint8Array[] = [];
  forEachLevelDbEntry(index, (_key, handle) => {
    const [blockOffset, afterBlockOffset] = readVarint(handle, 0);
    const [blockSize] = readVarint(handle, afterBlockOffset);
    blocks.push(readBlock(file, blockOffset, blockSize));
  });
  return blocks;
}

function collectLevelDbValues(block: Uint8Array, values: Map<string, LevelDbValue>): void {
  forEachLevelDbEntry(block, (key, value) => {
    if (key.length < 8) {
      throw new Error("invalid LevelDB internal key");
    }
    const userKey = Buffer.from(key.subarray(0, -8)).toString("latin1");
    const kind = key[key.length - 8];
    let sequence = 0n;
    for (let index = 0; index < 7; index += 1) {
      sequence |= BigInt(key[key.length - 7 + index] ?? 0) << BigInt(index * 8);
    }
    const current = values.get(userKey);
    if (current && sequence <= current.sequence) {
      return;
    }
    // Record the newest entry for every key even when it holds no group records, so a
    // deletion or a store whose last group was removed cannot lose to an older value.
    // Only marker-bearing payloads are retained, which keeps this bounded in memory.
    const live = kind === LEVELDB_VALUE_KIND && GROUP_RECORD_MARKER.test(localStorageText(value));
    values.set(userKey, { sequence, value: live ? value : EMPTY_VALUE });
  });
}

function isPlainGroupName(name: string): boolean {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function scanGroupRecords(raw: Uint8Array, parsed: ParsedGroups): void {
  const text = localStorageText(raw);
  for (const match of text.matchAll(/"id":"(cg-[a-f0-9-]+)","name":"([^"\\]{1,500})"/gi)) {
    const [, id, name] = match;
    if (id && name && isPlainGroupName(name) && !parsed.groups.has(id)) {
      parsed.groups.set(id, name);
    }
  }
  for (const match of text.matchAll(/"code:(local_[a-f0-9-]+)":"(cg-[a-f0-9-]+)"/gi)) {
    const [, sessionId, groupId] = match;
    if (sessionId && groupId && !parsed.assignments.has(sessionId)) {
      parsed.assignments.set(sessionId, groupId);
    }
  }
}

/**
 * Claude Desktop stores Code custom groups in Chromium Local Storage, not beside the session JSON.
 * This reads only labels and local-session assignments; it never mutates Desktop account state.
 */
export async function readClaudeDesktopCustomGroups(homeDir: string): Promise<Map<string, string>> {
  const root = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Claude",
    "Local Storage",
    "leveldb",
  );
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /\.(ldb|log)$/.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(root, entry.name);
        const stat = await fs.stat(filePath).catch(() => undefined);
        return stat && stat.size <= MAX_LEVELDB_FILE_BYTES
          ? { filePath, mtimeMs: stat.mtimeMs, size: stat.size }
          : undefined;
      }),
  );
  const levelDbValues = new Map<string, LevelDbValue>();
  const logRecords: ParsedGroups = { groups: new Map(), assignments: new Map() };
  let remainingBytes = MAX_LEVELDB_TOTAL_BYTES;
  for (const file of files
    .filter(
      (candidate): candidate is { filePath: string; mtimeMs: number; size: number } =>
        candidate !== undefined,
    )
    .toSorted(
      (left, right) => right.mtimeMs - left.mtimeMs || right.filePath.localeCompare(left.filePath),
    )
    .slice(0, MAX_LEVELDB_FILES)) {
    if (file.size > remainingBytes) {
      continue;
    }
    remainingBytes -= file.size;
    const raw = await fs.readFile(file.filePath).catch(() => undefined);
    if (!raw) {
      continue;
    }
    if (!file.filePath.endsWith(".ldb")) {
      scanGroupRecords(raw, logRecords);
      continue;
    }
    try {
      for (const block of levelDbDataBlocks(raw)) {
        collectLevelDbValues(block, levelDbValues);
      }
    } catch {
      // Chromium can compact while discovery is reading its local store.
    }
  }
  // The write-ahead log holds writes that have not been flushed into an SSTable yet, so
  // it seeds the result first and wins on conflict. It is scanned raw rather than replayed,
  // so its own internal ordering stays best-effort; SSTables then fill in the rest.
  const parsed: ParsedGroups = {
    groups: new Map(logRecords.groups),
    assignments: new Map(logRecords.assignments),
  };
  for (const { value } of levelDbValues.values()) {
    scanGroupRecords(value, parsed);
  }
  const assignments = new Map<string, string>();
  for (const [sessionId, groupId] of parsed.assignments) {
    const group = parsed.groups.get(groupId);
    if (group) {
      assignments.set(sessionId, group);
    }
  }
  return assignments;
}
