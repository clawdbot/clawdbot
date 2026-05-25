import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const opusDir = path.join(root, "node_modules", "@discordjs", "opus");

export function resolveNativeOpusInstallCommand(params = {}) {
  return resolvePnpmRunner({
    comSpec: params.comSpec,
    nodeExecPath: params.nodeExecPath,
    npmExecPath: params.npmExecPath,
    platform: params.platform,
    pnpmArgs: [
      "--dir",
      params.opusDir,
      "exec",
      "node-pre-gyp",
      "install",
      "--fallback-to-build",
    ],
  });
}

function isDirectRun(metaUrl = import.meta.url, argvPath = process.argv[1]) {
  return Boolean(argvPath) && path.resolve(argvPath) === fileURLToPath(metaUrl);
}

export function main() {
  if (!existsSync(path.join(opusDir, "package.json"))) {
    console.error(
      "Missing node_modules/@discordjs/opus. Run pnpm install first, then retry this opt-in installer.",
    );
    process.exit(1);
  }

  const install = resolveNativeOpusInstallCommand({ opusDir });
  const installResult = spawnSync(install.command, install.args, {
    cwd: root,
    env: install.env ?? process.env,
    stdio: "inherit",
    shell: install.shell,
    windowsVerbatimArguments: install.windowsVerbatimArguments,
  });

  if (installResult.status !== 0) {
    console.error(
      "Failed to install @discordjs/opus for the active Node runtime. Use Node 22 for the upstream macOS arm64 prebuild, or install a node-gyp toolchain for source builds.",
    );
    process.exit(installResult.status ?? 1);
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
}

if (isDirectRun()) {
  main();
}
