// Resolves and checks packaged Control UI assets.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import * as controlUiFsRuntime from "./control-ui-assets.fs.runtime.js";
import { resolveOpenClawPackageRoot, resolveOpenClawPackageRootSync } from "./openclaw-root.js";

export function formatControlUiSourceCommand(root: string, action: "build" | "dev"): string {
  const directory = process.platform === "win32" ? quotePowerShellArg(root) : quoteCliArg(root);
  return `pnpm --dir ${directory} ui:${action}`;
}

export function resolveControlUiDistIndexPathForRoot(root: string): string {
  return path.join(root, "dist", "control-ui", "index.html");
}

type ControlUiAssetHealth =
  | { kind: "missing-index"; indexPath: string | null }
  | { kind: "incomplete"; indexPath: string; missingAsset: string }
  | { kind: "ready"; indexPath: string };

export async function resolveControlUiAssetHealth(
  opts: {
    root?: string;
    argv1?: string;
    moduleUrl?: string;
  } = {},
): Promise<ControlUiAssetHealth> {
  const indexPath = opts.root
    ? resolveControlUiDistIndexPathForRoot(opts.root)
    : await resolveControlUiDistIndexPath({
        argv1: opts.argv1 ?? process.argv[1],
        moduleUrl: opts.moduleUrl,
      });
  return inspectControlUiAssetHealth(indexPath);
}

function resolveControlUiRepoRoot(opts: {
  root?: string;
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
}): string | null {
  const cwd = opts.cwd ?? process.cwd();
  const roots = opts.root
    ? [path.resolve(opts.root)]
    : [
        resolveOpenClawPackageRootSync({
          argv1: opts.argv1 ?? process.argv[1],
          moduleUrl: opts.moduleUrl ?? import.meta.url,
          cwd,
        }),
        resolveOpenClawPackageRootSync({ cwd }),
      ];
  return (
    roots.find(
      (root): root is string =>
        root !== null && controlUiFsRuntime.existsSync(path.join(root, "ui", "vite.config.ts")),
    ) ?? null
  );
}

async function resolveControlUiDistIndexPath(
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

type EnsureControlUiAssetsOptions = ControlUiRootResolveOptions & {
  root?: string;
  force?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onBuildStart?: () => void;
};

export const CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS = 10 * 60_000;

function controlUiAssetsFailure(message: string, built = false): EnsureControlUiAssetsResult {
  return { ok: false, built, message };
}

function inspectControlUiAssetHealth(indexPath: string | null): ControlUiAssetHealth {
  if (!indexPath) {
    return { kind: "missing-index", indexPath };
  }
  let html: string;
  try {
    if (controlUiFsRuntime.statSync(indexPath).size > 256 * 1024) {
      return { kind: "incomplete", indexPath, missingAsset: "index.html exceeds its size limit" };
    }
    html = controlUiFsRuntime.readFileSync(indexPath, "utf8");
  } catch {
    return { kind: "missing-index", indexPath };
  }
  let references = 0;
  for (const tag of html.matchAll(/<(?:link|script)\b[^>]*>/giu)) {
    const attribute = tag[0].match(/\s(?:href|src)\s*=\s*["']([^"']+)["']/iu);
    const reference = attribute?.[1]?.split(/[?#]/u, 1)[0]?.replace(/\\/gu, "/");
    if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(reference)) {
      continue;
    }
    const marker = reference.lastIndexOf("assets/");
    if (marker === -1 || !/\.(?:css|js)$/iu.test(reference)) {
      continue;
    }
    const asset = reference.slice(marker);
    if (++references > 128 || reference.split("/").includes("..")) {
      return {
        kind: "incomplete",
        indexPath,
        missingAsset: references > 128 ? "too many startup assets" : asset,
      };
    }
    if (!controlUiFsRuntime.existsSync(path.join(path.dirname(indexPath), asset))) {
      return { kind: "incomplete", indexPath, missingAsset: asset };
    }
  }
  return { kind: "ready", indexPath };
}

export function isControlUiStartupAssetsReady(root: string): boolean {
  return inspectControlUiAssetHealth(path.join(root, "index.html")).kind === "ready";
}

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
  opts: EnsureControlUiAssetsOptions = {},
): Promise<EnsureControlUiAssetsResult> {
  const argv1 = opts.argv1 ?? process.argv[1];
  const health = await resolveControlUiAssetHealth({
    ...(opts.root ? { root: opts.root } : {}),
    argv1,
    moduleUrl: opts.moduleUrl,
  });
  const indexFromDist = health.indexPath;
  let missingStartupAsset = health.kind === "incomplete" ? health.missingAsset : undefined;
  if (!opts.force && health.kind === "ready") {
    return { ok: true, built: false };
  }
  if (!opts.force && !opts.root) {
    const detectedRoot = resolveControlUiRootSync({
      argv1,
      moduleUrl: opts.moduleUrl,
      cwd: opts.cwd,
      execPath: opts.execPath,
    });
    if (detectedRoot) {
      const detectedHealth = inspectControlUiAssetHealth(path.join(detectedRoot, "index.html"));
      missingStartupAsset =
        detectedHealth.kind === "incomplete" ? detectedHealth.missingAsset : undefined;
      if (detectedHealth.kind === "ready") {
        return { ok: true, built: false };
      }
    }
  }

  const repoRoot = resolveControlUiRepoRoot({
    root: opts.root,
    argv1,
    moduleUrl: opts.moduleUrl,
    cwd: opts.cwd,
  });
  if (!repoRoot) {
    const hint = missingStartupAsset
      ? `Incomplete Control UI assets${indexFromDist ? ` at ${indexFromDist}` : ""} (missing ${missingStartupAsset})`
      : indexFromDist
        ? `Missing Control UI assets at ${indexFromDist}`
        : "Missing Control UI assets";
    return controlUiAssetsFailure(
      `${hint}. Reinstall OpenClaw to restore bundled Control UI assets.`,
    );
  }

  const indexPath = resolveControlUiDistIndexPathForRoot(repoRoot);
  if (!opts.force && inspectControlUiAssetHealth(indexPath).kind === "ready") {
    return { ok: true, built: false };
  }

  const uiScript = path.join(repoRoot, "scripts", "ui.js");
  if (!controlUiFsRuntime.existsSync(uiScript)) {
    return controlUiAssetsFailure(`Control UI assets missing but ${uiScript} is unavailable.`);
  }

  if (opts.signal?.aborted) {
    return controlUiAssetsFailure("Control UI build canceled.");
  }

  if (opts.onBuildStart) {
    opts.onBuildStart();
  } else {
    const buildCommand = formatControlUiSourceCommand(repoRoot, "build");
    const devCommand = formatControlUiSourceCommand(repoRoot, "dev");
    runtime.log(
      `Control UI assets missing; building them now (rerun \`${buildCommand}\` after UI changes, or use \`${devCommand}\` while developing the Control UI)…`,
    );
  }

  let build: Awaited<ReturnType<typeof runCommandWithTimeout>>;
  try {
    build = await runCommandWithTimeout([process.execPath, uiScript, "build"], {
      cwd: repoRoot,
      timeoutMs: opts.timeoutMs ?? CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return controlUiAssetsFailure(
      `Control UI build failed: ${summarizeCommandOutput(message) ?? "unknown error"}`,
    );
  }
  if (build.termination === "signal") {
    return controlUiAssetsFailure("Control UI build canceled.");
  }
  if (build.termination === "timeout" || build.termination === "no-output-timeout") {
    return controlUiAssetsFailure("Control UI build timed out.");
  }
  if (build.code !== 0) {
    return controlUiAssetsFailure(
      `Control UI build failed: ${summarizeCommandOutput(build.stderr) ?? `exit ${build.code}`}`,
    );
  }

  const builtHealth = inspectControlUiAssetHealth(indexPath);
  if (builtHealth.kind === "missing-index") {
    return controlUiAssetsFailure(
      `Control UI build completed but ${indexPath} is still missing.`,
      true,
    );
  }
  if (builtHealth.kind === "incomplete") {
    return controlUiAssetsFailure(
      `Control UI build completed but startup asset ${builtHealth.missingAsset} is missing.`,
      true,
    );
  }

  return { ok: true, built: true };
}
