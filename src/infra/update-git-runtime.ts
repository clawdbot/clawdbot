import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { resolveControlUiAssetHealth } from "./control-ui-assets.js";
import { tryReadJson } from "./json-files.js";
import { readPackageVersion } from "./package-json.js";
import type { UpdateRecovery } from "./update-recovery.js";

// The Git updater passes the canonical checkout and its successfully built HEAD.
export type GitRuntimeIdentity = { root: string; sha: string | null };

export async function collectGitRuntimeErrors(params: GitRuntimeIdentity): Promise<string[]> {
  const distRoot = path.join(params.root, "dist");
  const [buildInfo, buildStamp, runtimeStamp, entryExists, uiHealth] = await Promise.all([
    tryReadJson(path.join(distRoot, "build-info.json")),
    tryReadJson(path.join(distRoot, ".buildstamp")),
    tryReadJson(path.join(distRoot, ".runtime-postbuildstamp")),
    Promise.any([
      fs.stat(path.join(distRoot, "entry.js")),
      fs.stat(path.join(distRoot, "entry.mjs")),
    ]).then(
      () => true,
      () => false,
    ),
    resolveControlUiAssetHealth({ root: params.root }),
  ]);
  const commit = normalizeNullableString(asNullableRecord(buildInfo)?.commit);
  const buildHead = normalizeNullableString(asNullableRecord(buildStamp)?.head);
  const runtimeHead = normalizeNullableString(asNullableRecord(runtimeStamp)?.head);
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

export async function readBuiltGatewayBuildId(root: string): Promise<string | null> {
  const buildInfo = await tryReadJson(path.join(root, "dist", "build-info.json"));
  const buildId = normalizeNullableString(asNullableRecord(buildInfo)?.buildId);
  return buildId && buildId.length <= 96 ? buildId : null;
}

// Only pre-migration callers may use artifact verification to authorize recovery.
// A rebuild has its own build ID; a source SHA or package version cannot substitute for it.
export async function verifyGitUpdateRecovery(params: GitRuntimeIdentity): Promise<UpdateRecovery> {
  const [version, buildId, errors] = await Promise.all([
    readPackageVersion(params.root),
    readBuiltGatewayBuildId(params.root),
    collectGitRuntimeErrors(params),
  ]);
  return version && buildId && errors.length === 0
    ? { serviceRestartSafe: true, version, buildId }
    : { serviceRestartSafe: false, reason: "runtime-verification-failed" };
}
