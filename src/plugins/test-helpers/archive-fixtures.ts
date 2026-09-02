// Archive fixture helpers create compressed plugin archives for install and loader tests.
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";

/** Packs a test package directory into a gzipped tar archive. */
export async function packToArchive(params: {
  pkgDir: string;
  outDir: string;
  outName: string;
  flatRoot?: boolean;
}) {
  const dest = path.join(params.outDir, params.outName);
  fs.rmSync(dest, { force: true });
  await tar.c(
    {
      gzip: true,
      file: dest,
      cwd: params.flatRoot ? params.pkgDir : path.dirname(params.pkgDir),
    },
    [params.flatRoot ? "." : path.basename(params.pkgDir)],
  );
  return dest;
}
