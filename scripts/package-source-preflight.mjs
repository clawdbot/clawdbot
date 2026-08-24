#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCurrentPackageChangelog } from "./package-changelog.mjs";

const FULL_GIT_COMMIT_RE = /^[0-9a-f]{40}$/u;
const ROOT_MANIFEST_PATH = "package.json";
const AI_MANIFEST_PATH = "packages/ai/package.json";
const CHANGELOG_PATH = "CHANGELOG.md";

function parseArgs(argv) {
  const options = {
    allowUnreleasedChangelog: false,
    ref: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-unreleased-changelog") {
      options.allowUnreleasedChangelog = true;
      continue;
    }
    if (arg === "--ref") {
      options.ref = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown package source preflight option: ${arg}`);
  }
  if (!FULL_GIT_COMMIT_RE.test(options.ref)) {
    throw new Error(`--ref must be a full lowercase commit SHA; got ${options.ref || "<missing>"}`);
  }
  return options;
}

function parseManifest(content, manifestPath) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse ${manifestPath}.`, { cause: error });
  }
}

export function validatePackageSource({
  aiManifestContent,
  allowUnreleasedChangelog = false,
  changelogContent,
  rootManifestContent,
}) {
  const rootManifest = parseManifest(rootManifestContent, ROOT_MANIFEST_PATH);
  if (typeof rootManifest.version !== "string") {
    throw new Error(`${ROOT_MANIFEST_PATH} version must be a string.`);
  }
  extractCurrentPackageChangelog(changelogContent, rootManifest.version, {
    allowUnreleased: allowUnreleasedChangelog,
  });

  const rootDependencies = rootManifest.dependencies ?? {};
  const aiDependency = rootDependencies["@openclaw/ai"];
  if (aiManifestContent === null) {
    if (aiDependency === undefined) {
      return rootManifest.version;
    }
    throw new Error(`${ROOT_MANIFEST_PATH} declares @openclaw/ai without ${AI_MANIFEST_PATH}.`);
  }

  const aiManifest = parseManifest(aiManifestContent, AI_MANIFEST_PATH);
  if (aiDependency !== "workspace:*") {
    throw new Error(
      `${ROOT_MANIFEST_PATH} must depend on @openclaw/ai via workspace:*; found ${JSON.stringify(aiDependency)}.`,
    );
  }
  if (aiManifest.version !== rootManifest.version) {
    throw new Error(
      `${AI_MANIFEST_PATH} version must match ${ROOT_MANIFEST_PATH}: expected ${rootManifest.version}, found ${String(aiManifest.version ?? "<missing>")}.`,
    );
  }

  for (const [name, version] of Object.entries(aiManifest.dependencies ?? {})) {
    if (rootDependencies[name] !== version) {
      throw new Error(
        `${ROOT_MANIFEST_PATH} must match ${AI_MANIFEST_PATH} dependency ${name}@${version}; found ${JSON.stringify(rootDependencies[name])}.`,
      );
    }
  }
  return rootManifest.version;
}

function readGitFile(ref, file, { optional = false } = {}) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (error) {
    if (optional && error?.status === 128) {
      return null;
    }
    throw new Error(`Unable to read ${file} from ${ref}.`, { cause: error });
  }
}

export function validatePackageSourceRef(ref, options = {}) {
  return validatePackageSource({
    aiManifestContent: readGitFile(ref, AI_MANIFEST_PATH, { optional: true }),
    allowUnreleasedChangelog: options.allowUnreleasedChangelog,
    changelogContent: readGitFile(ref, CHANGELOG_PATH),
    rootManifestContent: readGitFile(ref, ROOT_MANIFEST_PATH),
  });
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const version = validatePackageSourceRef(options.ref, options);
  console.log(`package-source-preflight: source manifests and changelog are valid (${version}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
