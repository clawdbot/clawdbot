#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  createDecisionRecord,
  freezeSession,
  recheckDecisionAuthority,
  renderDecisionMarkdown,
  routeSession,
  validateDecisionRecord,
} from "./charrette-lib.mjs";
import {
  ContractError,
  MAX_RECORD_JSON_BYTES,
  MAX_RECORD_JSON_DEPTH,
  MAX_RECORD_JSON_NODES,
  prettyJson,
  readJsonStrict,
} from "./json-utils.mjs";

const usage = `Usage:
  node scripts/charrette.mjs route --input FILE [--output FILE]
  node scripts/charrette.mjs freeze --input FILE --timestamp ISO --output FILE
  node scripts/charrette.mjs decide --session FILE --findings FILE --output-json FILE
  node scripts/charrette.mjs validate-record --input FILE
  node scripts/charrette.mjs render-record --input FILE --output-md FILE
  node scripts/charrette.mjs recheck-record --input FILE --authority-session FILE
`;

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help")) {
    return { command: "help", flags: new Map() };
  }
  const [command, ...rest] = argv;
  const flags = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new ContractError(`Invalid argument near ${flag ?? "<end>"}`, "USAGE");
    }
    if (flags.has(flag)) {
      throw new ContractError(`Duplicate flag ${flag}`, "USAGE");
    }
    flags.set(flag, value);
  }
  return { command, flags };
}

function requireFlags(flags, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const flag of flags.keys()) {
    if (!allowed.has(flag)) {
      throw new ContractError(`Unknown flag ${flag}`, "USAGE");
    }
  }
  for (const flag of required) {
    if (!flags.has(flag)) {
      throw new ContractError(`Missing required flag ${flag}`, "USAGE");
    }
  }
}

const recordReadLimits = {
  maxBytes: MAX_RECORD_JSON_BYTES,
  maxDepth: MAX_RECORD_JSON_DEPTH,
  maxNodes: MAX_RECORD_JSON_NODES,
};

async function loadJson(path, limits) {
  const absolute = resolve(path);
  return readJsonStrict(absolute, limits);
}

async function resolveThroughExistingAncestor(path) {
  let cursor = resolve(path);
  const suffix = [];
  // Preserve missing output components while resolving every symlink in the existing prefix.
  while (true) {
    try {
      const prefix = await realpath(cursor);
      return resolve(prefix, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function pathIdentity(label, path) {
  const absolute = resolve(path);
  const canonical = await resolveThroughExistingAncestor(absolute);
  let inode = null;
  try {
    const status = await stat(absolute, { bigint: true });
    inode = `${status.dev}:${status.ino}`;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return { label, absolute, canonical, inode };
}

async function requireDistinctPaths(entries) {
  const identities = await Promise.all(entries.map(({ label, path }) => pathIdentity(label, path)));
  for (let left = 0; left < identities.length; left += 1) {
    for (let right = left + 1; right < identities.length; right += 1) {
      const first = identities[left];
      const second = identities[right];
      const sameCanonicalPath = first.canonical === second.canonical;
      const sameExistingFile = first.inode !== null && first.inode === second.inode;
      if (sameCanonicalPath || sameExistingFile) {
        throw new ContractError(
          `${first.label} and ${second.label} resolve to the same file`,
          "PATH_ALIAS_COLLISION",
        );
      }
    }
  }
}

async function assertSafeOutputPath(path) {
  const absolute = resolve(path);
  try {
    const status = await lstat(absolute);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new ContractError(
        `Output must be absent or a regular file: ${absolute}`,
        "UNSAFE_OUTPUT",
      );
    }
    throw new ContractError(`Output already exists: ${absolute}`, "OUTPUT_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return absolute;
}

async function stageOutput(path, content) {
  const absolute = await assertSafeOutputPath(path);
  const parent = dirname(absolute);
  const temporary = `${absolute}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { absolute, parent, temporary };
}

async function commitStagedOutputs(staged) {
  const committed = [];
  try {
    await Promise.all(staged.map((item) => assertSafeOutputPath(item.absolute)));
    for (const item of staged) {
      // link() is a no-clobber cutover; rename() could overwrite a raced output.
      await link(item.temporary, item.absolute);
      const status = await stat(item.absolute, { bigint: true });
      committed.push({ path: item.absolute, dev: status.dev, ino: status.ino });
      await unlink(item.temporary);
    }
    for (const parent of new Set(staged.map((item) => item.parent))) {
      const directory = await open(parent, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await Promise.all(staged.map((item) => unlink(item.temporary).catch(() => {})));
    for (const item of committed) {
      try {
        const status = await lstat(item.path, { bigint: true });
        if (status.dev === item.dev && status.ino === item.ino) {
          await unlink(item.path);
        }
      } catch {
        // A raced replacement is not ours to remove.
      }
    }
    throw error;
  }
}

async function writeAtomic(path, content) {
  const staged = await stageOutput(path, content);
  try {
    await commitStagedOutputs([staged]);
  } catch (error) {
    await unlink(staged.temporary).catch(() => {});
    throw error;
  }
}

async function preflightOutput(path) {
  await assertSafeOutputPath(path);
  const parent = dirname(resolve(path));
  const directory = await open(parent, "r");
  try {
    const status = await directory.stat();
    if (!status.isDirectory()) {
      throw new ContractError(`Output parent is not a directory: ${parent}`, "UNSAFE_OUTPUT");
    }
  } finally {
    await directory.close();
  }
}

async function main() {
  const { command, flags } = parseArguments(process.argv.slice(2));
  if (command === "help") {
    process.stdout.write(usage);
    return;
  }
  if (command === "route") {
    requireFlags(flags, ["--input"], ["--output"]);
    if (flags.has("--output")) {
      await requireDistinctPaths([
        { label: "--input", path: flags.get("--input") },
        { label: "--output", path: flags.get("--output") },
      ]);
      await preflightOutput(flags.get("--output"));
    }
    const result = routeSession(await loadJson(flags.get("--input")));
    const output = prettyJson(result);
    if (flags.has("--output")) {
      await writeAtomic(flags.get("--output"), output);
    } else {
      process.stdout.write(output);
    }
    return;
  }
  if (command === "freeze") {
    requireFlags(flags, ["--input", "--timestamp", "--output"]);
    await requireDistinctPaths([
      { label: "--input", path: flags.get("--input") },
      { label: "--output", path: flags.get("--output") },
    ]);
    await preflightOutput(flags.get("--output"));
    const frozen = freezeSession(await loadJson(flags.get("--input")), flags.get("--timestamp"));
    await writeAtomic(flags.get("--output"), prettyJson(frozen));
    process.stdout.write(
      `${prettyJson({
        state: frozen.state,
        freeze_digest: frozen.freeze_digest,
        output: resolve(flags.get("--output")),
      })}`,
    );
    return;
  }
  if (command === "decide") {
    requireFlags(flags, ["--session", "--findings", "--output-json"]);
    await requireDistinctPaths([
      { label: "--session", path: flags.get("--session") },
      { label: "--findings", path: flags.get("--findings") },
      { label: "--output-json", path: flags.get("--output-json") },
    ]);
    await preflightOutput(flags.get("--output-json"));
    const record = createDecisionRecord(
      await loadJson(flags.get("--session")),
      await loadJson(flags.get("--findings")),
    );
    const output = prettyJson(record);
    if (Buffer.byteLength(output, "utf8") > MAX_RECORD_JSON_BYTES) {
      throw new ContractError(
        `Decision record exceeds the ${MAX_RECORD_JSON_BYTES} byte round-trip limit`,
        "ARTIFACT_TOO_LARGE",
      );
    }
    await writeAtomic(flags.get("--output-json"), output);
    process.stdout.write(
      `${prettyJson({
        terminal_decision: record.terminal_decision,
        autonomous_continuation_allowed: record.autonomous_continuation_allowed,
        integrity_digest: record.integrity_digest,
      })}`,
    );
    return;
  }
  if (command === "validate-record") {
    requireFlags(flags, ["--input"]);
    const record = validateDecisionRecord(await loadJson(flags.get("--input"), recordReadLimits));
    process.stdout.write(
      `${prettyJson({
        valid: true,
        terminal_decision: record.terminal_decision,
        integrity_digest: record.integrity_digest,
      })}`,
    );
    return;
  }
  if (command === "render-record") {
    requireFlags(flags, ["--input", "--output-md"]);
    await requireDistinctPaths([
      { label: "--input", path: flags.get("--input") },
      { label: "--output-md", path: flags.get("--output-md") },
    ]);
    await preflightOutput(flags.get("--output-md"));
    const record = validateDecisionRecord(await loadJson(flags.get("--input"), recordReadLimits));
    await writeAtomic(flags.get("--output-md"), renderDecisionMarkdown(record));
    process.stdout.write(`${prettyJson({ valid: true })}`);
    return;
  }
  if (command === "recheck-record") {
    requireFlags(flags, ["--input", "--authority-session"]);
    await requireDistinctPaths([
      { label: "--input", path: flags.get("--input") },
      { label: "--authority-session", path: flags.get("--authority-session") },
    ]);
    const result = recheckDecisionAuthority(
      await loadJson(flags.get("--input"), recordReadLimits),
      await loadJson(flags.get("--authority-session")),
    );
    process.stdout.write(prettyJson(result));
    if (!result.authorized) {
      process.exitCode = 2;
    }
    return;
  }
  throw new ContractError(`Unknown command ${command}`, "USAGE");
}

main().catch((error) => {
  process.stderr.write(
    `${prettyJson({
      ok: false,
      code: error instanceof ContractError ? error.code : "UNEXPECTED_ERROR",
      error: error.message,
    })}`,
  );
  if (error?.code === "USAGE") {
    process.stderr.write(usage);
  }
  process.exitCode = 1;
});
