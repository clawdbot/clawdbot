import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { parseGitUrl } from "./utils/git.js";

const execFileAsync = promisify(execFile);
const MAX_PROJECT_KEY_CACHE_ENTRIES = 128;

const projectKeyByRepoRoot = new Map<string, Promise<string>>();

function escapeProjectKeyForAnnotation(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll(";", "%3b")
    .replaceAll("<", "%3c")
    .replaceAll(">", "%3e")
    .replaceAll("\r", "%0d")
    .replaceAll("\n", "%0a");
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

async function resolveUncachedProjectKey(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "config", "--get", "remote.origin.url"],
      { encoding: "utf8" },
    );
    const source = parseGitUrl(`git:${stdout.trim()}`);
    if (source) {
      // Userinfo is deliberately folded out so SSH and HTTPS clones converge.
      // This accepts a rare same-host, same-path collision across distinct SSH
      // accounts; the tradeoff is relevance bleed within one operator's store.
      // Preserve remote path case so case-sensitive hosts fail closed. Providers
      // with case-insensitive slugs may miss boosts/digests across casing variants,
      // but folding paths could cross-inject memory between distinct repositories.
      return escapeProjectKeyForAnnotation(`${source.host.toLowerCase()}/${source.path}`);
    }
  } catch {
    // Repositories without an origin intentionally use their canonical local root.
  }
  return `path:${escapeProjectKeyForAnnotation(repoRoot)}`;
}

/** Resolve one stable repository identity without spawning Git again for the same root. */
export function resolveProjectKey(repoRoot: string): Promise<string> {
  const canonicalRoot = path.resolve(repoRoot);
  const cached = projectKeyByRepoRoot.get(canonicalRoot);
  if (cached) {
    projectKeyByRepoRoot.delete(canonicalRoot);
    projectKeyByRepoRoot.set(canonicalRoot, cached);
    return cached;
  }
  const pending = resolveUncachedProjectKey(canonicalRoot);
  setBounded(projectKeyByRepoRoot, canonicalRoot, pending, MAX_PROJECT_KEY_CACHE_ENTRIES);
  return pending;
}
