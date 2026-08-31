import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// The fixture owns its package assets; resolving linked source back to the checkout
// makes Doctor repair that checkout instead, including building its Control UI.
const SOURCE_RUNTIME_NODE_ARGS = ["--preserve-symlinks", "--preserve-symlinks-main"];

export function runSourceRuntime(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeout: number,
) {
  return spawnSync(process.execPath, [...SOURCE_RUNTIME_NODE_ARGS, "--import", "tsx", ...args], {
    cwd: runtimeRoot,
    encoding: "utf8",
    env,
    timeout,
  });
}

export function runIsolatedModuleScript(
  env: NodeJS.ProcessEnv,
  script: string,
  options: { runtimeRoot?: string; timeoutMs?: number } = {},
) {
  return execFileAsync(
    process.execPath,
    [
      ...(options.runtimeRoot ? SOURCE_RUNTIME_NODE_ARGS : []),
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: options.runtimeRoot ?? path.resolve("."),
      encoding: "utf8",
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: options.timeoutMs ?? 30_000,
    },
  );
}

export function createSourceRuntime(root: string): string {
  const runtimeRoot = path.join(root, "runtime");
  fs.mkdirSync(path.join(runtimeRoot, "dist"), { recursive: true });
  for (const dirname of ["node_modules", "packages", "scripts", "src"]) {
    fs.symlinkSync(
      path.resolve(dirname),
      path.join(runtimeRoot, dirname),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  for (const filename of ["node-version.mjs", "package.json", "tsconfig.json"]) {
    fs.copyFileSync(path.resolve(filename), path.join(runtimeRoot, filename));
  }
  fs.writeFileSync(
    path.join(runtimeRoot, "dist", "build-info.json"),
    JSON.stringify({ builtAt: "2026-08-05T00:00:00.000Z" }),
  );
  const uiDir = path.join(runtimeRoot, "dist", "control-ui");
  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(path.join(uiDir, "index.html"), "<!doctype html>\n");
  return runtimeRoot;
}
