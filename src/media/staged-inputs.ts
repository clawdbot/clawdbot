import { createHash } from "node:crypto";
import { root as fsRoot, sanitizeUntrustedFileName, type Root } from "../infra/fs-safe.js";

const STAGED_INPUT_DIRECTORY_PREFIX = "media/inbound/openclaw-staged-";
export const STAGED_INPUT_GIT_PATHSPEC = `:(glob)${STAGED_INPUT_DIRECTORY_PREFIX}*/**`;
const STAGED_INPUT_GITIGNORE =
  "# Raw task inputs remain private; copy outputs into the project to publish.\n*\n";

const STAGED_INPUT_GITIGNORE_SHA256 = createHash("sha256")
  .update(STAGED_INPUT_GITIGNORE)
  .digest("hex");

/** A producer-shaped name is only a candidate; the marker establishes ownership. */
export function stagedInputPathDirectory(relativePath: string): string | undefined {
  if (!relativePath.startsWith(STAGED_INPUT_DIRECTORY_PREFIX)) {
    return undefined;
  }
  const identity = relativePath.slice(STAGED_INPUT_DIRECTORY_PREFIX.length).split("/")[0]!;
  const match =
    /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u.exec(
      identity,
    );
  return match?.[0] === identity ? STAGED_INPUT_DIRECTORY_PREFIX + identity : undefined;
}

export function isStagedInputPath(relativePath: string, directories: ReadonlySet<string>): boolean {
  const directory = stagedInputPathDirectory(relativePath);
  return directory !== undefined && directories.has(directory);
}

/** Capture-scoped, including negative results: never read the marker once per file. */
export function createStagedInputPathMatcher(
  root: Root,
): (relativePath: string) => Promise<boolean> {
  const directories = new Map<string, Promise<boolean>>();
  return async (relativePath) => {
    const directory = stagedInputPathDirectory(relativePath);
    if (!directory) {
      return false;
    }
    let owned = directories.get(directory);
    if (!owned) {
      owned = root
        .readText(`${directory}/.gitignore`, { maxBytes: STAGED_INPUT_GITIGNORE.length })
        .then(
          (text) => text === STAGED_INPUT_GITIGNORE,
          () => false,
        );
      directories.set(directory, owned);
    }
    return await owned;
  };
}

/** Complete manifests bind the regular marker's exact bytes through their file digest. */
export function stagedInputDirectoriesFromEntries(
  entries: readonly { path: string; type: string; size?: number; sha256?: string }[],
): Set<string> {
  const directories = new Set<string>();
  for (const entry of entries) {
    const directory = stagedInputPathDirectory(entry.path);
    if (
      directory &&
      entry.path === `${directory}/.gitignore` &&
      entry.type === "file" &&
      entry.size === STAGED_INPUT_GITIGNORE.length &&
      entry.sha256 === STAGED_INPUT_GITIGNORE_SHA256
    ) {
      directories.add(directory);
    }
  }
  return directories;
}

export const STAGED_INPUT_PATHS_JS = `
const STAGED_INPUT_DIRECTORY_PREFIX = ${JSON.stringify(STAGED_INPUT_DIRECTORY_PREFIX)};
const STAGED_INPUT_GITIGNORE = ${JSON.stringify(STAGED_INPUT_GITIGNORE)};
const STAGED_INPUT_GITIGNORE_SHA256 = ${JSON.stringify(STAGED_INPUT_GITIGNORE_SHA256)};
const stagedInputPathDirectory = ${stagedInputPathDirectory.toString()};
const isStagedInputPath = ${isStagedInputPath.toString()};
const stagedInputDirectoriesFromEntries = ${stagedInputDirectoriesFromEntries.toString()};`;

export function stagedInputDirectory(identity: string): string {
  return `${STAGED_INPUT_DIRECTORY_PREFIX}${identity}`;
}

export function stagedInputFileName(name: string): string {
  // A generic prefix keeps uploaded Git control filenames ordinary input files.
  return sanitizeUntrustedFileName(`input-${name}`, "input-attachment");
}

export async function ensureStagedInputDirectory(
  rootDir: string,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  const root = await fsRoot(rootDir);
  const ignorePath = `${directory}/.gitignore`;
  if (await root.exists(directory)) {
    if ((await root.readText(ignorePath, { maxBytes: 1024 })) !== STAGED_INPUT_GITIGNORE) {
      throw new Error("Input staging directory is not owned by OpenClaw");
    }
    return;
  }
  // Never add an exclusion to an existing project directory or replace its files.
  signal?.throwIfAborted();
  await root.create(ignorePath, STAGED_INPUT_GITIGNORE, { mode: 0o600 });
}
