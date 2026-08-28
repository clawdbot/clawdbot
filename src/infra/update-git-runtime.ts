import fs from "node:fs/promises";
import path from "node:path";
import { resolveControlUiAssetHealth } from "./control-ui-assets.js";

// The Git updater passes the canonical checkout and its successfully built HEAD.
export type GitRuntimeIdentity = { root: string; sha: string | null };

async function readHead(filePath: string, field: "commit" | "head"): Promise<string | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    return typeof value[field] === "string" ? value[field] : null;
  } catch {
    return null;
  }
}

export async function collectGitRuntimeErrors(params: GitRuntimeIdentity): Promise<string[]> {
  const distRoot = path.join(params.root, "dist");
  const [commit, buildHead, runtimeHead, entryExists, uiHealth] = await Promise.all([
    readHead(path.join(distRoot, "build-info.json"), "commit"),
    readHead(path.join(distRoot, ".buildstamp"), "head"),
    readHead(path.join(distRoot, ".runtime-postbuildstamp"), "head"),
    Promise.any([
      fs.stat(path.join(distRoot, "entry.js")),
      fs.stat(path.join(distRoot, "entry.mjs")),
    ]).then(
      () => true,
      () => false,
    ),
    resolveControlUiAssetHealth({ root: params.root }),
  ]);
  const verified =
    Boolean(params.sha) &&
    commit === params.sha &&
    buildHead === params.sha &&
    runtimeHead === params.sha &&
    entryExists &&
    uiHealth.kind === "ready";
  return verified
    ? []
    : [
        `git runtime mismatch (build=${commit ?? "missing"}, buildStamp=${buildHead ?? "missing"}, runtimeStamp=${runtimeHead ?? "missing"}, entry=${entryExists}, ui=${uiHealth.kind}, expected=${params.sha ?? "missing"})`,
      ];
}
