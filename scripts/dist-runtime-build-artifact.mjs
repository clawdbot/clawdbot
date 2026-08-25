import path from "node:path";
import { buildAndSmokeDistRuntimeArtifact } from "./lib/workspace-bootstrap-smoke.mts";

const archivePath = process.argv[2];
if (!archivePath) {
  throw new Error("Usage: node scripts/dist-runtime-build-artifact.mjs <archive-path>");
}

const result = await buildAndSmokeDistRuntimeArtifact({
  rootDir: process.cwd(),
  archivePath: path.resolve(archivePath),
});
console.log(`dist runtime artifact ready: ${result.archivePath}`);
