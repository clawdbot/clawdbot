#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryTree } from "../../../.agents/skills/cyborgclaw-groupthink-charrette/scripts/tree-integrity.mjs";

const evidenceRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(evidenceRoot, "../../..");
const sourceRoot = join(repositoryRoot, ".agents/skills/cyborgclaw-groupthink-charrette");
const inventoryName = "INTERNAL_SHA256SUMS.sha256";
const sourceInventoryName = "SOURCE_TREE_INVENTORY.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listFiles(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const status = await lstat(path);
    if (status.isSymbolicLink()) {
      throw new Error(`Evidence inventory refuses symlink: ${relative(root, path)}`);
    }
    if (status.isDirectory()) {
      files.push(...(await listFiles(root, path)));
      continue;
    }
    if (!status.isFile() || status.nlink !== 1) {
      throw new Error(`Evidence inventory refuses unsafe entry: ${relative(root, path)}`);
    }
    files.push(path);
  }
  return files;
}

const sourceInventory = await inventoryTree(sourceRoot);
if (sourceInventory.digest !== "3c788a417c3b00586760845d60f5859599c85acc9673bc8775b0ea97a80c05aa") {
  throw new Error(`Frozen source changed: ${sourceInventory.digest}`);
}

await writeFile(
  join(evidenceRoot, sourceInventoryName),
  `${JSON.stringify(
    {
      schema_version: "cyborgclaw.evidence-source-inventory.v1",
      source_path: ".agents/skills/cyborgclaw-groupthink-charrette",
      ...sourceInventory,
    },
    null,
    2,
  )}\n`,
);

const files = (await listFiles(evidenceRoot)).filter(
  (path) => relative(evidenceRoot, path) !== inventoryName,
);
const lines = [];
for (const path of files) {
  const relativePath = relative(evidenceRoot, path).split("\\").join("/");
  lines.push(`${sha256(await readFile(path))}  ./${relativePath}`);
}
await writeFile(join(evidenceRoot, inventoryName), `${lines.join("\n")}\n`);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      source_inventory_digest: sourceInventory.digest,
      source_entries: sourceInventory.entry_count,
      evidence_inventory_entries: lines.length,
    },
    null,
    2,
  )}\n`,
);
