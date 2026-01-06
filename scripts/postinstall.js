import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isBunInstall() {
  const ua = process.env.npm_config_user_agent ?? "";
  return ua.includes("bun/");
}

function getRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (typeof res.status === "number") return res.status;
  return 1;
}

function applyPatchIfNeeded(opts) {
  const patchPath = path.resolve(opts.patchPath);
  if (!fs.existsSync(patchPath)) {
    throw new Error(`missing patch: ${patchPath}`);
  }

  let targetDir = path.resolve(opts.targetDir);
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    console.warn(`[postinstall] skip missing target: ${targetDir}`);
    return;
  }

  // Resolve symlinks to avoid "beyond a symbolic link" errors from git apply
  // (bun/pnpm use symlinks in node_modules)
  targetDir = fs.realpathSync(targetDir);

  const gitArgsBase = ["apply", "--unsafe-paths", "--whitespace=nowarn"];
  const reverseCheck = [
    ...gitArgsBase,
    "--reverse",
    "--check",
    "--directory",
    targetDir,
    patchPath,
  ];
  const forwardCheck = [
    ...gitArgsBase,
    "--check",
    "--directory",
    targetDir,
    patchPath,
  ];
  const apply = [...gitArgsBase, "--directory", targetDir, patchPath];

  // Already applied?
  if (run("git", reverseCheck, { stdio: "ignore" }) === 0) {
    return;
  }

  if (run("git", forwardCheck, { stdio: "ignore" }) !== 0) {
    throw new Error(`patch does not apply cleanly: ${path.basename(patchPath)}`);
  }

  const status = run("git", apply);
  if (status !== 0) {
    throw new Error(`failed applying patch: ${path.basename(patchPath)}`);
  }
}

function extractPackageName(key) {
  if (key.startsWith("@")) {
    const idx = key.indexOf("@", 1);
    if (idx === -1) return key;
    return key.slice(0, idx);
  }
  const idx = key.lastIndexOf("@");
  if (idx <= 0) return key;
  return key.slice(0, idx);
}

function main() {
  if (!isBunInstall()) return;

  const repoRoot = getRepoRoot();
  process.chdir(repoRoot);

  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const patched = pkg?.pnpm?.patchedDependencies ?? {};

  // Bun does not support pnpm.patchedDependencies. Apply these patch files to
  // node_modules packages as a best-effort compatibility layer.
  for (const [key, relPatchPath] of Object.entries(patched)) {
    if (typeof relPatchPath !== "string" || !relPatchPath.trim()) continue;
    const pkgName = extractPackageName(String(key));
    if (!pkgName) continue;
    applyPatchIfNeeded({
      targetDir: path.join("node_modules", ...pkgName.split("/")),
      patchPath: relPatchPath,
    });
  }
}

try {
  main();
} catch (err) {
  console.error(String(err));
  process.exit(1);
}
