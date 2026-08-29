// Rebind packaged runtime metadata to the synthetic Git fixture; no source is compiled.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

assert(
  fs.existsSync("dist/entry.js") || fs.existsSync("dist/entry.mjs"),
  "package-derived Git fixture is missing its runtime entry",
);
const buildInfo = JSON.parse(fs.readFileSync("dist/build-info.json", "utf8"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
fs.writeFileSync("dist/build-info.json", `${JSON.stringify({ ...buildInfo, commit: head })}\n`);
fs.writeFileSync("dist/.buildstamp", `${JSON.stringify({ builtAt: Date.now(), head })}\n`);
fs.writeFileSync(
  "dist/.runtime-postbuildstamp",
  `${JSON.stringify({ syncedAt: Date.now(), head })}\n`,
);
