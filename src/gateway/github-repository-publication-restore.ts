import { NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES } from "../worker/node-workspace-protocol.js";
import { GITHUB_PUBLICATION_CONFIG_GUARD_JS } from "./github-publication-base.js";
import {
  createGitHubPublicationCommandRunner,
  readGitHubPublicationTree,
} from "./github-publication-git-transport.js";
import { readGitHubRepositoryPublicationMetadata } from "./github-repository-publication-snapshot.js";
import type { WorkerWorkspaceManifest } from "./worker-environments/workspace-manifest.js";

const RESTORE_PUBLICATION_INDEX_JS = String.raw`
const fs = require("node:fs");
const gitNullPath = process.platform === "win32" ? "NUL" : "/dev/null";
const { spawnSync } = require("node:child_process");
const paths = JSON.parse(fs.readFileSync(0, "utf8"));
const cwd = process.cwd();
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
Object.assign(env, { GIT_CONFIG_GLOBAL: gitNullPath, GIT_CONFIG_SYSTEM: gitNullPath,
  GIT_CONFIG_COUNT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" });
${GITHUB_PUBLICATION_CONFIG_GUARD_JS}
const action = process.argv[1];
if (action !== "add" && action !== "remove") throw Error("Invalid publication restore operation");
const operation = action === "remove" ? ["update-index", "--force-remove", "-z", "--stdin"] :
  ["add", "--intent-to-add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"];
const result = spawnSync("git", ["--literal-pathspecs", "-c", "core.hooksPath=" + gitNullPath,
  "-c", "core.fsmonitor=false", "-c", "core.attributesFile=" + gitNullPath,
  ...operation], {
  env,
  input: paths.join("\0") + "\0", timeout: 60000, maxBuffer: 128 * 1024,
});
if (result.error || result.status !== 0) {
  throw Error("Repository publication paths could not be restored; retry workspace preparation");
}
`;

/** Recover publication membership, not the prior staging contents or private recovery-only paths. */
export async function prepareRepositoryPublicationRestore(params: {
  current: WorkerWorkspaceManifest;
  publicationStagingRoot?: string;
  publicationDigest?: string;
  indexBase?: { root: string; commit: string; assertCurrent: () => void };
}): Promise<Array<{ argv: string[]; input: string }>> {
  if (!params.publicationStagingRoot || !params.publicationDigest) {
    return [];
  }
  const { snapshot } = await readGitHubRepositoryPublicationMetadata(
    params.publicationStagingRoot,
    params.publicationDigest,
  );
  if (snapshot.baseCommit !== params.current.baseCommit) {
    throw new Error("Repository publication paths differ from the restored source baseline");
  }
  const current = new Map(params.current.entries.map((entry) => [entry.path, entry]));
  const overlay = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const accepted = new Map(overlay);
  const removed = new Set(
    snapshot.entries
      .filter((entry) => entry.sha === null && entry.mode !== "160000")
      .map((entry) => entry.path),
  );
  let indexed: Set<string> | undefined;
  if (params.indexBase) {
    const { root, commit, assertCurrent } = params.indexBase;
    const { run } = createGitHubPublicationCommandRunner(assertCurrent);
    const readTree = async (tree: string) => {
      const raw = await readGitHubPublicationTree(root, tree, run);
      const text = raw.toString("utf8");
      if (!Buffer.from(text).equals(raw)) {
        throw new Error("Repository publication paths are not valid UTF-8");
      }
      return text
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const tab = record.indexOf("\t");
          const [mode, , sha] = record.slice(0, tab).split(" ");
          if (tab < 0 || !mode || !sha) {
            throw new Error("Repository publication tree inventory is invalid");
          }
          return { path: record.slice(tab + 1), mode, sha };
        });
    };
    const [baseTree, indexTree] = await Promise.all([
      readTree(snapshot.baseTree),
      readTree(commit),
    ]);
    indexed = new Set(indexTree.map((entry) => entry.path));
    // C's delta is relative to A, while this fresh index now represents pushed B.
    // Overlay A before comparing membership; B-only ignored files may remain raw recovery files.
    for (const entry of baseTree) {
      if (
        !overlay.has(entry.path) &&
        (entry.mode === "100644" || entry.mode === "100755" || entry.mode === "120000")
      ) {
        accepted.set(entry.path, { ...entry, mode: entry.mode, sha: entry.sha });
      }
    }
    for (const entry of indexTree) {
      if (entry.mode !== "160000" && !accepted.get(entry.path)?.sha) {
        removed.add(entry.path);
      }
    }
  }
  const added = [...accepted.values()].flatMap((entry) => {
    const raw = current.get(entry.path);
    const file = (entry.mode === "100644" || entry.mode === "100755") && raw?.type === "file";
    const symlink = entry.mode === "120000" && raw?.type === "symlink";
    return entry.sha && !indexed?.has(entry.path) && (file || symlink || !overlay.has(entry.path))
      ? [entry.path]
      : [];
  });
  const commands: Array<{ argv: string[]; input: string }> = [];
  // Deletions remove only index entries; raw recovery bytes stay available.
  // Added contents remain unstaged through intent-to-add. Never enroll raw-only paths.
  for (const [action, paths] of [
    ["remove", [...removed]],
    ["add", added],
  ] as const) {
    let batch: string[] = [];
    let bytes = 2;
    const flush = () => {
      if (batch.length) {
        commands.push({
          argv: ["node", "-e", RESTORE_PUBLICATION_INDEX_JS, action],
          input: JSON.stringify(batch),
        });
        batch = [];
        bytes = 2;
      }
    };
    // Reserve room for JSON escaping inside the enclosing workspace command request.
    const limit = NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES / 2;
    for (const file of paths) {
      const size = Buffer.byteLength(JSON.stringify(file)) + 1;
      if (size + 2 > limit) {
        throw new Error("Repository publication path exceeds the restore command limit");
      }
      if (bytes + size > limit) {
        flush();
      }
      batch.push(file);
      bytes += size;
    }
    flush();
  }
  return commands;
}
