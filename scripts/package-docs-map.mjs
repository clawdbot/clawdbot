#!/usr/bin/env node

// Materializes the generated docs map only while npm assembles a package tarball.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocsHeadingMap } from "./docs-list.js";

const DOCS_MAP_PATH = path.join("docs", "docs_map.md");
const RECEIPT_PATH = path.join(".artifacts", "package-docs-map", "receipt.json");

function activePreparationError() {
  return Object.assign(
    new Error(
      `Another package preparation owns ${DOCS_MAP_PATH}; wait for it to finish or run \`node scripts/openclaw-postpack.mjs\` after an interrupted pack.`,
    ),
    { code: "PACKAGE_DOCS_MAP_ACTIVE" },
  );
}

function preparationRestoreError(error, restoreError) {
  return new AggregateError(
    [error, restoreError],
    `Writing ${DOCS_MAP_PATH} failed and its source state could not be restored.`,
    { cause: error },
  );
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Restore the source map stub after prepack replaced it with generated content. */
export async function restorePackageDocsMap(cwd = process.cwd()) {
  const receiptPath = path.join(cwd, RECEIPT_PATH);
  if (!existsSync(receiptPath)) {
    return false;
  }
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (
    !receipt ||
    typeof receipt.generatedSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.generatedSha256) ||
    (receipt.original !== null && typeof receipt.original !== "string")
  ) {
    throw new Error(`Invalid package docs-map receipt at ${RECEIPT_PATH}.`);
  }

  const mapPath = path.join(cwd, DOCS_MAP_PATH);
  const current = existsSync(mapPath) ? await readFile(mapPath, "utf8") : null;
  if (current === receipt.original) {
    await rm(receiptPath, { force: true });
    return true;
  }
  if (current === null || sha256(current) !== receipt.generatedSha256) {
    throw new Error(
      `Refusing to restore ${DOCS_MAP_PATH} because it changed after prepack generated it.`,
    );
  }
  if (receipt.original === null) {
    await rm(mapPath);
  } else {
    await writeFile(mapPath, receipt.original, "utf8");
  }
  await rm(receiptPath, { force: true });
  return true;
}

/** Generate the shipped docs map for npm while recording the source state for cleanup. */
export async function preparePackageDocsMap(cwd = process.cwd()) {
  const receiptPath = path.join(cwd, RECEIPT_PATH);
  if (existsSync(receiptPath)) {
    throw activePreparationError();
  }
  const mapPath = path.join(cwd, DOCS_MAP_PATH);
  const content = renderDocsHeadingMap(path.join(cwd, "docs"));
  const original = existsSync(mapPath) ? await readFile(mapPath, "utf8") : null;
  // The receipt owns every source-mutating pack step, even when the map is
  // already generated; skipping it lets another pack restore our prepared files.
  await mkdir(path.dirname(receiptPath), { recursive: true });
  try {
    await writeFile(
      receiptPath,
      `${JSON.stringify({ generatedSha256: sha256(content), original })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw activePreparationError();
    }
    throw error;
  }
  try {
    await writeFile(mapPath, content, "utf8");
  } catch (error) {
    try {
      await restorePackageDocsMap(cwd);
    } catch (restoreError) {
      throw preparationRestoreError(error, restoreError);
    }
    throw error;
  }
  return true;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || (argv[0] !== "prepare" && argv[0] !== "restore")) {
    console.error("Usage: node scripts/package-docs-map.mjs <prepare|restore>");
    process.exitCode = 1;
    return;
  }
  const changed =
    argv[0] === "prepare" ? await preparePackageDocsMap() : await restorePackageDocsMap();
  console.error(
    changed
      ? `package-docs-map: ${argv[0] === "prepare" ? "generated" : "removed"} transient docs map.`
      : `package-docs-map: no ${argv[0] === "prepare" ? "generation" : "cleanup"} needed.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
