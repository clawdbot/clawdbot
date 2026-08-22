import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveMacOSDesktopCodexAppPathCandidates,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-paths.js";

/** Fingerprints every desktop candidate that can own a managed fallback artifact. */
export async function readMacOSDesktopGenerationFingerprint(
  candidates: readonly MacOSDesktopCodexAppPathCandidate[] = resolveMacOSDesktopCodexAppPathCandidates(
    "darwin",
  ),
): Promise<string> {
  const entries: string[] = [];
  for (const candidate of candidates) {
    const command = await statFingerprint(candidate.appServerCommandPath);
    entries.push(`candidate:${candidate.appName}:${candidate.appServerCommandPath}:${command}`);
    for (const artifactPath of resolveMacOSDesktopGenerationPaths(candidate)) {
      entries.push(`${artifactPath}\0${await statFingerprint(artifactPath)}`);
    }
  }
  return createHash("sha256").update(entries.join("\0")).digest("hex");
}

function resolveMacOSDesktopGenerationPaths(
  candidate: MacOSDesktopCodexAppPathCandidate,
): string[] {
  return [
    candidate.appBundlePath,
    path.join(candidate.bundledMarketplacePath, ".agents", "plugins", "marketplace.json"),
    path.join(
      candidate.bundledMarketplacePath,
      "plugins",
      "computer-use",
      ".codex-plugin",
      "plugin.json",
    ),
    ...candidate.computerUseServiceAppPaths.flatMap((servicePath) => [
      servicePath,
      path.join(servicePath, "Contents", "Info.plist"),
      path.join(
        servicePath,
        "Contents",
        "SharedSupport",
        "SkyComputerUseClient.app",
        "Contents",
        "MacOS",
        "SkyComputerUseClient",
      ),
    ]),
  ];
}

/** Stable directories whose immediate children cover every fingerprinted artifact. */
export function resolveMacOSDesktopGenerationWatchPaths(
  candidates: readonly MacOSDesktopCodexAppPathCandidate[] = resolveMacOSDesktopCodexAppPathCandidates(
    "darwin",
  ),
): string[] {
  const watched = new Set<string>(["/Applications"]);
  for (const candidate of candidates) {
    watched.add(candidate.appBundlePath);
    const directoryArtifacts = new Set([
      candidate.appBundlePath,
      ...candidate.computerUseServiceAppPaths,
    ]);
    for (const artifactPath of [
      candidate.appServerCommandPath,
      ...resolveMacOSDesktopGenerationPaths(candidate),
    ]) {
      let directory = directoryArtifacts.has(artifactPath)
        ? artifactPath
        : path.dirname(artifactPath);
      while (directory.startsWith(`${candidate.appBundlePath}${path.sep}`)) {
        watched.add(directory);
        directory = path.dirname(directory);
      }
    }
  }
  return [...watched];
}

async function statFingerprint(filePath: string): Promise<string> {
  try {
    const entry = await fs.lstat(filePath, { bigint: true });
    const type = entry.isSymbolicLink()
      ? "link"
      : entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other";
    const own = statTuple(entry);
    if (!entry.isSymbolicLink()) {
      const content = entry.isFile() ? await readFileFingerprint(filePath, entry, false) : "";
      return `${type}:${own}:${content}`;
    }
    const [link, realPath, target] = await Promise.all([
      fs.readlink(filePath),
      fs.realpath(filePath),
      fs.stat(filePath, { bigint: true }),
    ]);
    const content = target.isFile() ? await readFileFingerprint(filePath, target, true) : "";
    return `${type}:${own}:${link}:${realPath}:${statTuple(target)}:${content}`;
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return "missing";
    }
    throw error;
  }
}

async function readFileFingerprint(
  filePath: string,
  expected: BigIntStats,
  followsSymlink: boolean,
): Promise<string> {
  const noFollow = followsSymlink ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameStat(before, expected)) {
      throw new Error(`Codex desktop artifact changed while fingerprinting: ${filePath}`);
    }
    const hash = createHash("sha256");
    // Metadata can collide on coarse filesystems. Content binds an event-driven generation
    // to the exact executable/config bytes without adding request-hot-path polling.
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStat(before, after)) {
      throw new Error(`Codex desktop artifact changed while fingerprinting: ${filePath}`);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return statTuple(left) === statTuple(right);
}

function statTuple(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
