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
  const entries = params.flatRoot ? fs.readdirSync(params.pkgDir) : [path.basename(params.pkgDir)];
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
