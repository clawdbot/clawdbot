#!/usr/bin/env node

import { chmodSync, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  check(Number.isSafeInteger(parsed) && parsed > 0, `${label} must be a positive integer`);
  return parsed;
}

function regularFiles(root) {
  const files = [];
  const visit = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      check(entry.isFile(), `publish tree contains non-regular file: ${relative}`);
      files.push({ absolute, relative });
    }
  };
  visit(root, "");
  return files;
}

export function copyBundleMetadata({ bundleDir, destinationDir }) {
  const entries = readdirSync(bundleDir, { withFileTypes: true });
  const metadata = entries
    .filter(
      (entry) => entry.isFile() && (entry.name === "bundle.json" || entry.name.endsWith(".sha256")),
    )
    .map((entry) => entry.name)
    .toSorted();
  check(metadata.includes("bundle.json"), "Kova bundle metadata is missing bundle.json");
  check(
    metadata.some((name) => name.endsWith(".sha256")),
    "Kova bundle metadata is missing a checksum",
  );

  mkdirSync(destinationDir, { recursive: true });
  for (const name of metadata) {
    const source = path.join(bundleDir, name);
    const destination = path.join(destinationDir, name);
    copyFileSync(source, destination);
    chmodSync(destination, 0o644);
  }
  return metadata;
}

export function assertPublishedFileSizeLimit({ publishRoot, maxFileBytes }) {
  const limit = positiveInteger(maxFileBytes, "max file bytes");
  const files = regularFiles(publishRoot);
  for (const file of files) {
    const size = statSync(file.absolute).size;
    check(
      size <= limit,
      `refusing to publish oversized file ${file.relative}: ${size} bytes exceeds ${limit}`,
    );
  }
  return files.length;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    check(flag?.startsWith("--") && value, "invalid CLI arguments");
    const key = flag.slice(2);
    check(
      ["bundle-dir", "bundle-destination", "publish-root", "max-file-bytes"].includes(key),
      `unknown --${key}`,
    );
    check(values[key] === undefined, `duplicate --${key}`);
    values[key] = value;
  }
  for (const key of ["bundle-dir", "bundle-destination", "publish-root", "max-file-bytes"]) {
    check(values[key], `missing --${key}`);
  }
  return values;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const bundleFiles = copyBundleMetadata({
    bundleDir: args["bundle-dir"],
    destinationDir: args["bundle-destination"],
  });
  const publishedFileCount = assertPublishedFileSizeLimit({
    publishRoot: args["publish-root"],
    maxFileBytes: args["max-file-bytes"],
  });
  console.log(JSON.stringify({ bundleFiles, publishedFileCount }));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
