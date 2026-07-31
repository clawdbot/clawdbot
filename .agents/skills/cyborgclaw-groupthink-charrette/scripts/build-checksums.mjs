#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryTree } from "./tree-integrity.mjs";

const ownDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = dirname(ownDirectory);
const checksumName = "SHA256SUMS.sha256";

function parseArguments(argv) {
  const result = { root: defaultRoot, check: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) {
      throw new Error(`Duplicate argument: ${argument}`);
    }
    seen.add(argument);
    if (argument === "--check") {
      result.check = true;
    } else if (argument === "--root") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--root requires a path");
      }
      result.root = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return result;
}

function expectedContent(inventory) {
  return `${inventory.entries
    .filter((entry) => entry.type === "file" && entry.path !== checksumName)
    .map((entry) => {
      if (/[\r\n]/.test(entry.path)) {
        throw new Error(`Unsupported newline in payload path: ${entry.path}`);
      }
      return `${entry.sha256}  ${entry.path}`;
    })
    .join("\n")}\n`;
}

async function writeAtomic(path, content) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

const options = parseArguments(process.argv.slice(2));
const root = resolve(options.root);
const inventory = await inventoryTree(root);
const expected = expectedContent(inventory);
const checksumPath = join(root, checksumName);
if (options.check) {
  const actual = await readFile(checksumPath, "utf8");
  if (actual !== expected) {
    throw new Error(`${checksumPath} does not match the payload`);
  }
  process.stdout.write(
    `${JSON.stringify({ valid: true, checked_files: expected.trim().split("\n").length })}\n`,
  );
} else {
  await writeAtomic(checksumPath, expected);
  const finalInventory = await inventoryTree(root);
  const finalExpected = expectedContent(finalInventory);
  const finalActual = await readFile(checksumPath, "utf8");
  if (finalExpected !== expected || finalActual !== finalExpected) {
    throw new Error("payload changed while checksums were being written");
  }
  process.stdout.write(
    `${JSON.stringify({
      written: checksumPath,
      inventory_digest: finalInventory.digest,
      checked_files: finalExpected.trim().split("\n").length,
    })}\n`,
  );
}
