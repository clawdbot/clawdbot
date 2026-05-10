import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const opusDir = path.join(root, "node_modules", "@discordjs", "opus");

if (!existsSync(path.join(opusDir, "package.json"))) {
  console.error(
    "Missing node_modules/@discordjs/opus. Run pnpm install first, then retry this opt-in installer.",
  );
  process.exit(1);
}

const install = spawnSync(
  "pnpm",
  ["--dir", opusDir, "exec", "node-pre-gyp", "install", "--fallback-to-build"],
  {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  },
);

if (install.status !== 0) {
  console.error(
    "Failed to install @discordjs/opus for the active Node runtime. Use Node 22 for the upstream macOS arm64 prebuild, or install a node-gyp toolchain for source builds.",
  );
  process.exit(install.status ?? 1);
}

const verify = spawnSync(process.execPath, ["-e", 'require("@discordjs/opus")'], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});

if (verify.status !== 0) {
  console.error("@discordjs/opus installed, but the active Node runtime still cannot load it.");
  process.exit(verify.status ?? 1);
}

console.log("native opus ok");
