#!/usr/bin/env node
/**
 * Heap snapshot diff utility for OpenClaw test memory leak investigations.
 */

import fs from "node:fs";
import path from "node:path";

function printUsage() {
  console.error(
    "Usage: node heapsnapshot-delta.mjs <before.heapsnapshot> <after.heapsnapshot> [--top N] [--min-kb N]",
  );
  console.error(
    "   or: node heapsnapshot-delta.mjs --lane-dir <dir> [--pid PID] [--top N] [--min-kb N]",
  );
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    top: 30,
    minKb: 64,
    laneDir: null,
    pid: null,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--top") {
      options.top = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--min-kb") {
      options.minKb = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--lane-dir") {
      options.laneDir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--pid") {
      options.pid = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    options.files.push(arg);
  }

  if (!Number.isFinite(options.top) || options.top <= 0) {
    fail("--top must be a positive integer");
  }
  if (!Number.isFinite(options.minKb) || options.minKb < 0) {
    fail("--min-kb must be a non-negative integer");
  }
  if (options.pid !== null && (!Number.isInteger(options.pid) || options.pid <= 0)) {
    fail("--pid must be a positive integer");
  }

  return options;
}

class JsonStreamScanner {
  constructor(filePath) {
    this.stream = fs.createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 1024 * 1024,
    });
    this.iterator = this.stream[Symbol.asyncIterator]();
    this.buffer = "";
    this.offset = 0;
    this.done = false;
  }

  compactBuffer() {
    if (this.offset > 65536) {
      this.buffer = this.buffer.slice(this.offset);
      this.offset = 0;
    }
  }

  async ensureAvailable(count = 1) {
    while (!this.done && this.buffer.length - this.offset < count) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      this.buffer += next.value;
    }
  }

  async peek() {
    await this.ensureAvailable(1);
    return this.buffer[this.offset] ?? null;
  }

  async next() {
    await this.ensureAvailable(1);
    if (this.offset >= this.buffer.length) {
      return null;
    }
    const char = this.buffer[this.offset];
    this.offset += 1;
    this.compactBuffer();
    return char;
  }

  async skipWhitespace() {
    while (true) {
      const char = await this.peek();
      if (char === null || !/\s/u.test(char)) {
        return;
      }
      await this.next();
    }
  }

  async expectChar(expected) {
    const char = await this.next();
    if (char !== expected) {
      fail(`Expected ${expected} but found ${char ?? "<eof>"}`);
    }
  }

  async find(sequence) {
    let matched = 0;
    while (true) {
      const char = await this.next();
      if (char === null) {
        fail(`Could not find ${sequence}`);
      }
      if (char === sequence[matched]) {
        matched += 1;
        if (matched === sequence.length) {
          return;
        }
        continue;
      }
      matched = char === sequence[0] ? 1 : 0;
      if (matched === sequence.length) {
        return;
      }
    }
  }

  async readBalancedObject() {
    const start = await this.next();
    if (start !== "{") {
      fail(`Expected { but found ${start ?? "<eof>"}`);
    }
    let text = "{";
    let depth = 1;
    let inString = false;
    let escaped = false;
    while (depth > 0) {
      const char = await this.next();
      if (char === null) {
        fail("Unexpected EOF while reading JSON object");
      }
      text += char;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    return text;
  }

  async parseNumberArray(onValue) {
    await this.skipWhitespace();
    await this.expectChar("[");
    await this.skipWhitespace();
    if ((await this.peek()) === "]") {
      await this.next();
      return;
    }

    let token = "";
    let index = 0;
    const flush = () => {
      if (token.length === 0) {
        fail("Unexpected empty number token");
      }
      const value = Number.parseInt(token, 10);
      if (!Number.isFinite(value)) {
        fail(`Invalid numeric token: ${token}`);
      }
      onValue(value, index);
      index += 1;
      token = "";
    };

    while (true) {
      const char = await this.next();
      if (char === null) {
        fail("Unexpected EOF while reading number array");
      }
      if (char === "]") {
        flush();
        return;
      }
      if (char === ",") {
        flush();
        continue;
      }
      if (/\s/u.test(char)) {
        continue;
      }
      token += char;
    }
  }

  async readJsonString() {
    await this.expectChar('"');
    let value = "";
    while (true) {
      const char = await this.next();
      if (char === null) {
        fail("Unexpected EOF while reading JSON string");
      }
      if (char === '"') {
        return value;
      }
      if (char !== "\\") {
        value += char;
        continue;
      }
      const escaped = await this.next();
      if (escaped === null) {
        fail("Unexpected EOF while reading JSON string escape");
      }
      if (escaped === "u") {
        let hex = "";
        for (let index = 0; index < 4; index += 1) {
          const hexChar = await this.next();
          if (hexChar === null) {
            fail("Unexpected EOF while reading JSON unicode escape");
          }
          hex += hexChar;
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        continue;
      }
      value +=
        escaped === "b"
          ? "\b"
          : escaped === "f"
            ? "\f"
            : escaped === "n"
              ? "\n"
              : escaped === "r"
                ? "\r"
                : escaped === "t"
                  ? "\t"
                  : escaped;
    }
  }

  async parseStringArray(onValue) {
    await this.skipWhitespace();
    await this.expectChar("[");
    await this.skipWhitespace();
    if ((await this.peek()) === "]") {
      await this.next();
      return;
    }

    let index = 0;
    while (true) {
      const value = await this.readJsonString();
      onValue(value, index);
      index += 1;
      await this.skipWhitespace();
      const separator = await this.next();
      if (separator === "]") {
        return;
      }
      if (separator !== ",") {
        fail(`Expected , or ] but found ${separator ?? "<eof>"}`);
      }
      await this.skipWhitespace();
    }
  }
}

function parseHeapFilename(filePath) {
  const base = path.basename(filePath);
  const match = base.match(
    /^Heap\.(?<stamp>\d{8}\.\d{6})\.(?<pid>\d+)\.0\.(?<seq>\d+)\.heapsnapshot$/u,
  );
  if (!match?.groups) {
    return null;
  }
  return {
    filePath,
    pid: Number.parseInt(match.groups.pid, 10),
    stamp: match.groups.stamp,
    sequence: Number.parseInt(match.groups.seq, 10),
  };
}

function resolvePair(options) {
  if (options.laneDir) {
    const entries = fs
      .readdirSync(options.laneDir)
      .map((name) => parseHeapFilename(path.join(options.laneDir, name)))
      .filter((entry) => entry !== null)
      .filter((entry) => options.pid === null || entry.pid === options.pid)
      .toSorted((left, right) => {
        if (left.pid !== right.pid) {
          return left.pid - right.pid;
        }
        if (left.stamp !== right.stamp) {
          return left.stamp.localeCompare(right.stamp);
        }
        return left.sequence - right.sequence;
      });

    if (entries.length === 0) {
      fail(`No matching heap snapshots found in ${options.laneDir}`);
    }

    const groups = new Map();
    for (const entry of entries) {
      const group = groups.get(entry.pid) ?? [];
      group.push(entry);
      groups.set(entry.pid, group);
    }

    const candidates = Array.from(groups.values())
      .map((group) => ({
        pid: group[0].pid,
        before: group[0],
        after: group.at(-1),
        count: group.length,
      }))
      .filter((entry) => entry.count >= 2);

    if (candidates.length === 0) {
      fail(`Need at least two snapshots for one PID in ${options.laneDir}`);
    }

    const chosen =
      options.pid !== null
        ? (candidates.find((entry) => entry.pid === options.pid) ?? null)
        : candidates.toSorted((left, right) => right.count - left.count || left.pid - right.pid)[0];

    if (!chosen) {
      fail(`No PID with at least two snapshots matched in ${options.laneDir}`);
    }

    return {
      before: chosen.before.filePath,
      after: chosen.after.filePath,
      pid: chosen.pid,
      snapshotCount: chosen.count,
    };
  }

  if (options.files.length !== 2) {
    printUsage();
    process.exit(1);
  }

  return {
    before: options.files[0],
    after: options.files[1],
    pid: null,
    snapshotCount: 2,
  };
}

async function parseSnapshotMeta(scanner) {
  await scanner.find('"snapshot":');
  await scanner.skipWhitespace();
  const metaObjectText = await scanner.readBalancedObject();
  const parsed = JSON.parse(metaObjectText);
  return parsed?.meta ?? null;
}

async function buildSummary(filePath) {
  const scanner = new JsonStreamScanner(filePath);
  const meta = await parseSnapshotMeta(scanner);
  if (!meta) {
    fail(`Invalid heap snapshot: ${filePath}`);
  }

  const nodeFieldCount = meta.node_fields.length;
  const typeNames = meta.node_types[0];
  const typeIndex = meta.node_fields.indexOf("type");
  const nameIndex = meta.node_fields.indexOf("name");
  const selfSizeIndex = meta.node_fields.indexOf("self_size");
  if (typeIndex === -1 || nameIndex === -1 || selfSizeIndex === -1) {
    fail(`Unsupported heap snapshot schema: ${filePath}`);
  }

  const summaryByIndex = new Map();
  let nodeCount = 0;
  let currentTypeId = 0;
  let currentNameId = 0;
  let currentSelfSize = 0;
  await scanner.find('"nodes":');
  await scanner.parseNumberArray((value, index) => {
    const fieldIndex = index % nodeFieldCount;
    if (fieldIndex === typeIndex) {
      currentTypeId = value;
      return;
    }
    if (fieldIndex === nameIndex) {
      currentNameId = value;
      return;
    }
    if (fieldIndex === selfSizeIndex) {
      currentSelfSize = value;
    }
    if (fieldIndex !== nodeFieldCount - 1) {
      return;
    }
    const key = `${currentTypeId}\t${currentNameId}`;
    const current = summaryByIndex.get(key) ?? {
      typeId: currentTypeId,
      nameId: currentNameId,
      selfSize: 0,
      count: 0,
    };
    current.selfSize += currentSelfSize;
    current.count += 1;
    summaryByIndex.set(key, current);
    nodeCount += 1;
  });

  const requiredNameIds = new Set(
    Array.from(summaryByIndex.values(), (entry) => entry.nameId).filter((value) => value >= 0),
  );
  const nameStrings = new Map();
  await scanner.find('"strings":');
  await scanner.parseStringArray((value, index) => {
    if (requiredNameIds.has(index)) {
      nameStrings.set(index, value);
    }
  });

  const summary = new Map();
  for (const entry of summaryByIndex.values()) {
    const key = `${typeNames[entry.typeId] ?? "unknown"}\t${nameStrings.get(entry.nameId) ?? ""}`;
    summary.set(key, {
      type: typeNames[entry.typeId] ?? "unknown",
      name: nameStrings.get(entry.nameId) ?? "",
      selfSize: entry.selfSize,
      count: entry.count,
    });
  }

  return {
    nodeCount,
    summary,
  };
}

function formatBytes(bytes) {
  if (Math.abs(bytes) >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  }
  if (Math.abs(bytes) >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

function formatDelta(bytes) {
  return `${bytes >= 0 ? "+" : "-"}${formatBytes(Math.abs(bytes))}`;
}

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pair = resolvePair(options);
  const before = await buildSummary(pair.before);
  const after = await buildSummary(pair.after);
  const minBytes = options.minKb * 1024;

  const rows = [];
  for (const [key, next] of after.summary) {
    const previous = before.summary.get(key) ?? { selfSize: 0, count: 0 };
    const sizeDelta = next.selfSize - previous.selfSize;
    const countDelta = next.count - previous.count;
    if (sizeDelta < minBytes) {
      continue;
    }
    rows.push({
      type: next.type,
      name: next.name,
      sizeDelta,
      countDelta,
      afterSize: next.selfSize,
      afterCount: next.count,
    });
  }

  rows.sort(
    (left, right) => right.sizeDelta - left.sizeDelta || right.countDelta - left.countDelta,
  );

  console.log(`before: ${pair.before}`);
  console.log(`after:  ${pair.after}`);
  if (pair.pid !== null) {
    console.log(`pid:    ${pair.pid} (${pair.snapshotCount} snapshots found)`);
  }
  console.log(
    `nodes:   ${before.nodeCount} -> ${after.nodeCount} (${after.nodeCount - before.nodeCount >= 0 ? "+" : ""}${after.nodeCount - before.nodeCount})`,
  );
  console.log(`filter:  top=${options.top} min=${options.minKb} KiB`);
  console.log("");

  if (rows.length === 0) {
    console.log("No entries exceeded the minimum delta.");
    return;
  }

  for (const row of rows.slice(0, options.top)) {
    console.log(
      [
        formatDelta(row.sizeDelta).padStart(11),
        `count ${row.countDelta >= 0 ? "+" : ""}${row.countDelta}`.padStart(10),
        row.type.padEnd(16),
        truncate(row.name || "(empty)", 96),
      ].join("  "),
    );
  }
}

await main();
