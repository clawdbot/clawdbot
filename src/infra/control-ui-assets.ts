import fs from "node:fs";
import path from "node:path";

import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export function resolveControlUiRepoRoot(
  argv1: string | undefined = process.argv[1],
): string | null {
  if (!argv1) return null;
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const srcIndex = parts.lastIndexOf("src");
  if (srcIndex !== -1) {
    const root = parts.slice(0, srcIndex).join(path.sep);
    if (fs.existsSync(path.join(root, "ui", "vite.config.ts"))) return root;
  }

  let dir = path.dirname(normalized);
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "ui", "vite.config.ts"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function resolveControlUiDistIndexPath(
  argv1: string | undefined = process.argv[1],
): string | null {
  if (!argv1) return null;
  const normalized = path.resolve(argv1);
  const distDir = path.dirname(normalized);
  if (path.basename(distDir) !== "dist") return null;
  return path.join(distDir, "control-ui", "index.html");
}

export type EnsureControlUiAssetsResult = {
  ok: boolean;
  built: boolean;
  message?: string;
};

function summarizeCommandOutput(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return undefined;
  const last = lines.at(-1);
  if (!last) return undefined;
  return last.length > 240 ? `${last.slice(0, 239)}…` : last;
}

export async function ensureControlUiAssetsBuilt(
  runtime: RuntimeEnv = defaultRuntime,
  opts?: { timeoutMs?: number },
): Promise<EnsureControlUiAssetsResult> {
  const indexFromDist = resolveControlUiDistIndexPath(process.argv[1]);
  if (indexFromDist && fs.existsSync(indexFromDist)) {
    return { ok: true, built: false };
  }

  const repoRoot = resolveControlUiRepoRoot(process.argv[1]);
  if (!repoRoot) {
    const hint = indexFromDist
      ? `Missing Control UI assets at ${indexFromDist}`
      : "Missing Control UI assets";
    return {
      ok: false,
      built: false,
      message: `${hint}. Build them with \`bun run ui:build\`.`,
    };
  }

  const indexPath = path.join(repoRoot, "dist", "control-ui", "index.html");
  if (fs.existsSync(indexPath)) {
    return { ok: true, built: false };
  }

  const uiScript = path.join(repoRoot, "scripts", "ui.js");
  if (!fs.existsSync(uiScript)) {
    return {
      ok: false,
      built: false,
      message: `Control UI assets missing but ${uiScript} is unavailable.`,
    };
  }

  runtime.log("Control UI assets missing; building (ui:build)…");

  const ensureInstalled = !fs.existsSync(
    path.join(repoRoot, "ui", "node_modules"),
  );
  if (ensureInstalled) {
    const install = await runCommandWithTimeout(
      [process.execPath, uiScript, "install"],
      {
        cwd: repoRoot,
        timeoutMs: opts?.timeoutMs ?? 10 * 60_000,
      },
    );
    if (install.code !== 0) {
      return {
        ok: false,
        built: false,
        message: `Control UI install failed: ${summarizeCommandOutput(install.stderr) ?? `exit ${install.code}`}`,
      };
    }
  }

  const build = await runCommandWithTimeout(
    [process.execPath, uiScript, "build"],
    {
      cwd: repoRoot,
      timeoutMs: opts?.timeoutMs ?? 10 * 60_000,
    },
  );
  if (build.code !== 0) {
    return {
      ok: false,
      built: false,
      message: `Control UI build failed: ${summarizeCommandOutput(build.stderr) ?? `exit ${build.code}`}`,
    };
  }

  if (!fs.existsSync(indexPath)) {
    return {
      ok: false,
      built: true,
      message: `Control UI build completed but ${indexPath} is still missing.`,
    };
  }

  return { ok: true, built: true };
}
