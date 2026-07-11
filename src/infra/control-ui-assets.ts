// Resolves and checks packaged Control UI assets.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import * as controlUiFsRuntime from "./control-ui-assets.fs.runtime.js";
import { resolveOpenClawPackageRoot, resolveOpenClawPackageRootSync } from "./openclaw-root.js";

const CONTROL_UI_DIST_PATH_SEGMENTS = ["dist", "control-ui", "index.html"] as const;

export function resolveControlUiDistIndexPathForRoot(root: string): string {
  return path.join(root, ...CONTROL_UI_DIST_PATH_SEGMENTS);
}

type ControlUiDistIndexHealth = {
  indexPath: string | null;
  exists: boolean;
};

export async function resolveControlUiDistIndexHealth(
  opts: {
    root?: string;
    argv1?: string;
    moduleUrl?: string;
  } = {},
): Promise<ControlUiDistIndexHealth> {
  const indexPath = opts.root
    ? resolveControlUiDistIndexPathForRoot(opts.root)
    : await resolveControlUiDistIndexPath({
        argv1: opts.argv1 ?? process.argv[1],
        moduleUrl: opts.moduleUrl,
      });
  return {
    indexPath,
    exists: Boolean(indexPath && controlUiFsRuntime.existsSync(indexPath)),
  };
}

export function resolveControlUiRepoRoot(
  argv1: string | undefined = process.argv[1],
): string | null {
  if (!argv1) {
    return null;
  }
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const srcIndex = parts.lastIndexOf("src");
  if (srcIndex !== -1) {
    const root = parts.slice(0, srcIndex).join(path.sep);
    if (controlUiFsRuntime.existsSync(path.join(root, "ui", "vite.config.ts"))) {
      return root;
    }
  }

  let dir = path.dirname(normalized);
  for (let i = 0; i < 8; i++) {
    if (
      controlUiFsRuntime.existsSync(path.join(dir, "package.json")) &&
      controlUiFsRuntime.existsSync(path.join(dir, "ui", "vite.config.ts"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

export async function resolveControlUiDistIndexPath(
  argv1OrOpts?: string | { argv1?: string; moduleUrl?: string },
): Promise<string | null> {
  const argv1 =
    typeof argv1OrOpts === "string" ? argv1OrOpts : (argv1OrOpts?.argv1 ?? process.argv[1]);
  const moduleUrl = typeof argv1OrOpts === "object" ? argv1OrOpts?.moduleUrl : undefined;
  if (!argv1) {
    return null;
  }
  const normalized = path.resolve(argv1);
  const entrypointCandidates = [normalized];
  try {
    const realpathEntrypoint = controlUiFsRuntime.realpathSync(normalized);
    if (realpathEntrypoint !== normalized) {
      entrypointCandidates.push(realpathEntrypoint);
    }
  } catch {
    // Ignore missing/non-realpath argv1 and keep path-based candidates.
  }

  // Case 1: entrypoint is directly inside dist/ (e.g., dist/entry.js).
  // Include symlink-resolved argv1 so global wrappers (e.g. Bun) still map to dist/control-ui.
  for (const entrypoint of entrypointCandidates) {
    const distDir = path.dirname(entrypoint);
    if (path.basename(distDir) === "dist") {
      return path.join(distDir, "control-ui", "index.html");
    }
  }

  const packageRoot = await resolveOpenClawPackageRoot({ argv1: normalized, moduleUrl });
  if (packageRoot) {
    return path.join(packageRoot, "dist", "control-ui", "index.html");
  }

  // Fallback: traverse up and find package.json with name "openclaw" + dist/control-ui/index.html
  // This handles global installs where path-based resolution might fail.
  const fallbackStartDirs = new Set(
    entrypointCandidates.map((candidate) => path.dirname(candidate)),
  );
  for (const startDir of fallbackStartDirs) {
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
      const pkgJsonPath = path.join(dir, "package.json");
      const indexPath = path.join(dir, "dist", "control-ui", "index.html");
      if (controlUiFsRuntime.existsSync(pkgJsonPath)) {
        try {
          const raw = controlUiFsRuntime.readFileSync(pkgJsonPath, "utf-8");
          const parsed = JSON.parse(raw) as { name?: unknown };
          if (parsed.name === "openclaw") {
            return controlUiFsRuntime.existsSync(indexPath) ? indexPath : null;
          }
          // Stop at the first package boundary to avoid resolving through unrelated ancestors.
          break;
        } catch {
          // Invalid package.json at package boundary; abort this candidate chain.
          break;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  return null;
}

type ControlUiRootResolveOptions = {
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
};

function pathsMatchByRealpathOrResolve(left: string, right: string): boolean {
  let realLeft: string;
  let realRight: string;
  try {
    realLeft = controlUiFsRuntime.realpathSync(left);
  } catch {
    realLeft = path.resolve(left);
  }
  try {
    realRight = controlUiFsRuntime.realpathSync(right);
  } catch {
    realRight = path.resolve(right);
  }
  return realLeft === realRight;
}

function addCandidate(candidates: Set<string>, value: string | null) {
  if (!value) {
    return;
  }
  candidates.add(path.resolve(value));
}

export function resolveControlUiRootOverrideSync(rootOverride: string): string | null {
  const resolved = path.resolve(rootOverride);
  try {
    const stats = controlUiFsRuntime.statSync(resolved);
    if (stats.isFile()) {
      return path.basename(resolved) === "index.html" ? path.dirname(resolved) : null;
    }
    if (stats.isDirectory()) {
      const indexPath = path.join(resolved, "index.html");
      return controlUiFsRuntime.existsSync(indexPath) ? resolved : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveControlUiRootSync(opts: ControlUiRootResolveOptions = {}): string | null {
  const candidates = new Set<string>();
  const argv1 = opts.argv1 ?? process.argv[1];
  const cwd = opts.cwd ?? process.cwd();
  const moduleDir = opts.moduleUrl ? path.dirname(fileURLToPath(opts.moduleUrl)) : null;
  const argv1Dir = argv1 ? path.dirname(path.resolve(argv1)) : null;
  const argv1RealpathDir = (() => {
    if (!argv1) {
      return null;
    }
    try {
      return path.dirname(controlUiFsRuntime.realpathSync(path.resolve(argv1)));
    } catch {
      return null;
    }
  })();
  const execDir = (() => {
    try {
      const execPath = opts.execPath ?? process.execPath;
      return path.dirname(controlUiFsRuntime.realpathSync(execPath));
    } catch {
      return null;
    }
  })();
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1,
    moduleUrl: opts.moduleUrl,
    cwd,
  });

  // Packaged app: prefer bundled resources, then support legacy alongside-executable layout.
  addCandidate(candidates, execDir ? path.join(execDir, "../Resources/control-ui") : null);
  addCandidate(candidates, execDir ? path.join(execDir, "control-ui") : null);
  if (moduleDir) {
    // dist/<bundle>.js -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "control-ui"));
    // dist/gateway/control-ui.js -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "../control-ui"));
    // src/gateway/control-ui.ts -> dist/control-ui
    addCandidate(candidates, path.join(moduleDir, "../../dist/control-ui"));
  }
  if (argv1Dir) {
    // openclaw.mjs or dist/<bundle>.js
    addCandidate(candidates, path.join(argv1Dir, "dist", "control-ui"));
    addCandidate(candidates, path.join(argv1Dir, "control-ui"));
  }
  if (argv1RealpathDir && argv1RealpathDir !== argv1Dir) {
    // Symlinked wrappers (e.g. ~/.bun/bin/openclaw -> .../dist/index.js)
    addCandidate(candidates, path.join(argv1RealpathDir, "dist", "control-ui"));
    addCandidate(candidates, path.join(argv1RealpathDir, "control-ui"));
  }
  if (packageRoot) {
    addCandidate(candidates, path.join(packageRoot, "dist", "control-ui"));
  }
  addCandidate(candidates, path.join(cwd, "dist", "control-ui"));

  for (const dir of candidates) {
    const indexPath = path.join(dir, "index.html");
    if (controlUiFsRuntime.existsSync(indexPath)) {
      return dir;
    }
  }
  return null;
}

export function isPackageProvenControlUiRootSync(
  root: string,
  opts: ControlUiRootResolveOptions = {},
): boolean {
  const argv1 = opts.argv1 ?? process.argv[1];
  const cwd = opts.cwd ?? process.cwd();
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1,
    moduleUrl: opts.moduleUrl,
    cwd,
  });
  if (!packageRoot) {
    return false;
  }
  const packageDistRoot = path.join(packageRoot, "dist", "control-ui");
  return pathsMatchByRealpathOrResolve(root, packageDistRoot);
}

type EnsureControlUiAssetsResult = {
  ok: boolean;
  built: boolean;
  message?: string;
};

function summarizeCommandOutput(text: string): string | undefined {
  const lines = normalizeStringEntries(text.split(/\r?\n/g));
  if (!lines.length) {
    return undefined;
  }
  const last = lines.at(-1);
  if (!last) {
    return undefined;
  }
  return last.length > 240 ? `${truncateUtf16Safe(last, 239)}…` : last;
}

export async function ensureControlUiAssetsBuilt(
  runtime: RuntimeEnv = defaultRuntime,
  opts?: { timeoutMs?: number },
): Promise<EnsureControlUiAssetsResult> {
  const health = await resolveControlUiDistIndexHealth({ argv1: process.argv[1] });
  const indexFromDist = health.indexPath;
  if (health.exists) {
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
      message: `${hint}. Build them with \`pnpm ui:build\` (auto-installs UI deps).`,
    };
  }

  const indexPath = resolveControlUiDistIndexPathForRoot(repoRoot);
  if (controlUiFsRuntime.existsSync(indexPath)) {
    return { ok: true, built: false };
  }

  const uiScript = path.join(repoRoot, "scripts", "ui.js");
  if (!controlUiFsRuntime.existsSync(uiScript)) {
    return {
      ok: false,
      built: false,
      message: `Control UI assets missing but ${uiScript} is unavailable.`,
    };
  }

  runtime.log(
    "Control UI assets missing; building them now (rerun `pnpm ui:build` after UI changes, or use `pnpm ui:dev` while developing the Control UI)…",
  );

  const build = await runCommandWithTimeout([process.execPath, uiScript, "build"], {
    cwd: repoRoot,
    timeoutMs: opts?.timeoutMs ?? 10 * 60_000,
  });
  if (build.code !== 0) {
    return {
      ok: false,
      built: false,
      message: `Control UI build failed: ${summarizeCommandOutput(build.stderr) ?? `exit ${build.code}`}`,
    };
  }

  if (!controlUiFsRuntime.existsSync(indexPath)) {
    return {
      ok: false,
      built: true,
      message: `Control UI build completed but ${indexPath} is still missing.`,
    };
  }

  return { ok: true, built: true };
}
