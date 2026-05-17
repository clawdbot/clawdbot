import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";

export async function packToArchive(params: {
  pkgDir: string;
  outDir: string;
  outName: string;
  flatRoot?: boolean;
}) {
  const dest = path.join(params.outDir, params.outName);
  fs.rmSync(dest, { force: true });
  const entries = params.flatRoot
    ? listFlatRootArchiveEntries(params.pkgDir)
    : [path.basename(params.pkgDir)];
  await tar.c(
    {
      gzip: true,
      file: dest,
      cwd: params.flatRoot ? params.pkgDir : path.dirname(params.pkgDir),
    },
    entries,
  );
  return dest;
}

export function listFlatRootArchiveEntries(pkgDir: string): string[] {
  const externalEntries = listFindFlatRootArchiveEntries(pkgDir);
  if (externalEntries) {
    return externalEntries;
  }
  return fs.readdirSync(pkgDir).toSorted((left, right) => left.localeCompare(right));
}

function listFindFlatRootArchiveEntries(pkgDir: string): string[] | null {
  if (process.platform === "win32") {
    return null;
  }
  const result = spawnSync("find", [pkgDir, "-mindepth", "1", "-maxdepth", "1"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((entry) => path.basename(entry))
    .toSorted((left, right) => left.localeCompare(right));
}
