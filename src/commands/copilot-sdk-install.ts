import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { modelSelectionShouldEnsureCopilotSdk as routingShouldEnsure } from "../agents/copilot-routing.js";
import { resolveIsNixMode, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/**
 * On-demand install for `@github/copilot-sdk`, the runtime dependency of
 * the bundled `copilot` agent runtime extension.
 *
 * The extension itself is shipped inside the openclaw tarball, but the
 * SDK and its platform-specific CLI binary add ~260 MB of download to a
 * baseline openclaw install. Most openclaw users do not use the Copilot
 * runtime, so we install the SDK lazily: the wizard offers to install
 * it the first time the user selects a `github-copilot/*` model.
 *
 * Mirrors the codex on-demand install pattern in
 * `./codex-runtime-plugin-install.ts`, but installs a single npm
 * package (the SDK) rather than a full openclaw plugin, so the install
 * machinery here is much smaller than `ensureCodexRuntimePluginForModelSelection`.
 *
 * The fallback-dir resolver and `COPILOT_SDK_SPEC` are mirrored in the
 * copilot extension's sdk-loader module; contract tests keep them aligned.
 */
export function resolveCopilotSdkFallbackDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "npm-runtime", "copilot");
}

export const COPILOT_SDK_FALLBACK_DIR = resolveCopilotSdkFallbackDir();

export const COPILOT_SDK_SPEC = "@github/copilot-sdk@1.0.0-beta.4";

export const COPILOT_SDK_PACKAGE_LABEL = "GitHub Copilot SDK (@github/copilot-sdk)";

/**
 * Directory containing the checked-in {@link COPILOT_SDK_SPEC} install graph
 * (`package.json` + `package-lock.json`). Both files are generated via
 * `npm install --package-lock-only` and committed under
 * `src/commands/copilot-sdk-install-manifest/`. The build step in
 * `scripts/copy-copilot-sdk-manifest.ts` copies them alongside the
 * compiled output so `import.meta.url`-based resolution works in
 * published tarballs.
 *
 * Using `npm ci` against this graph means user installs cannot pull a
 * newer Copilot CLI or transitive dependency set than the one this PR
 * was reviewed against (review #2, P1).
 */
export const COPILOT_SDK_INSTALL_MANIFEST_DIR = fileURLToPath(
  new URL("./copilot-sdk-install-manifest/", import.meta.url),
);

export type CopilotSdkInstallStatus =
  | "already-installed"
  | "installed"
  | "declined"
  | "failed"
  | "nix-mode";

export type CopilotSdkInstallResult = {
  cfg: OpenClawConfig;
  required: boolean;
  installed: boolean;
  status?: CopilotSdkInstallStatus;
};

export function selectedModelShouldEnsureCopilotSdk(params: {
  cfg: OpenClawConfig;
  model?: string;
}): boolean {
  return routingShouldEnsure({ config: params.cfg, model: params.model });
}

export function isCopilotSdkInstalled(
  fallbackDir: string = resolveCopilotSdkFallbackDir(),
): boolean {
  const sdkPath = path.join(fallbackDir, "node_modules", "@github", "copilot-sdk");
  return existsSync(sdkPath);
}

export interface InstallCopilotSdkOptions {
  readonly fallbackDir?: string;
  readonly spec?: string;
  readonly manifestDir?: string;
  readonly logger?: (message: string) => void;
  readonly runInstall?: (cmd: { dir: string; spec: string; manifestDir: string }) => Promise<void>;
}

export interface InstallCopilotSdkResult {
  readonly installed: boolean;
  readonly fallbackDir: string;
  readonly spec: string;
}

/**
 * Result of {@link verifyCopilotSdkInstall}. `ok: true` means the install
 * at `fallbackDir` matches the pinned manifest in `manifestDir` exactly,
 * and the caller can skip running `npm ci` again. Any `ok: false` carries a
 * `reason` suitable for surfacing in setup logs and triggering a reinstall.
 */
export interface CopilotSdkVerifyResult {
  readonly ok: boolean;
  readonly reason?: string;
}

const COPILOT_SDK_PINNED_PACKAGE_KEYS = [
  "node_modules/@github/copilot-sdk",
  "node_modules/@github/copilot",
] as const;

function stableStringifyJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}

/**
 * Confirms that the on-demand install at `fallbackDir` matches the
 * pinned lock graph declared in the shipped manifest at `manifestDir`.
 * The directory check used to be the only gate (`isCopilotSdkInstalled`),
 * but that lets stale, partial, or manually placed trees bypass the
 * reviewed dependency graph. This verifier closes that hole by comparing
 * the shipped `package-lock.json` as a whole against the install's lock
 * AND the installed package.json files for the runtime entry packages.
 *
 * Manifest-side errors (missing file, malformed JSON, missing pinned
 * version entry) are treated as fatal because a packaged openclaw install
 * cannot recover from a broken shipped manifest. Install-side errors
 * (missing lock, unreadable package.json) are returned as reinstall
 * signals so npm ci can wipe and restage.
 */
export function verifyCopilotSdkInstall(
  fallbackDir: string,
  manifestDir: string,
): CopilotSdkVerifyResult {
  let manifestLock: { packages?: Record<string, { version?: string }> };
  const manifestLockPath = path.join(manifestDir, "package-lock.json");
  try {
    manifestLock = JSON.parse(readFileSync(manifestLockPath, "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };
  } catch (err) {
    throw new Error(
      `[copilot] cannot read pinned SDK manifest at ${manifestLockPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  // Validate the shipped manifest contract upfront before touching the install
  // tree. A broken manifest is a fatal build/packaging error and must surface
  // regardless of whether the fallback dir is empty, partial, or already
  // installed.
  const expectedVersions: Record<string, string> = {};
  for (const key of COPILOT_SDK_PINNED_PACKAGE_KEYS) {
    const expected = manifestLock.packages?.[key]?.version;
    if (!expected) {
      throw new Error(
        `[copilot] pinned SDK manifest at ${manifestLockPath} is missing a version for ${key}; refusing to verify install`,
      );
    }
    expectedVersions[key] = expected;
  }

  const installedLockPath = path.join(fallbackDir, "package-lock.json");
  if (!existsSync(installedLockPath)) {
    return { ok: false, reason: `no pinned package-lock.json at ${installedLockPath}` };
  }
  let installedLock: { packages?: Record<string, { version?: string }> };
  try {
    installedLock = JSON.parse(readFileSync(installedLockPath, "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };
  } catch (err) {
    return {
      ok: false,
      reason: `unreadable fallback package-lock.json: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  for (const key of COPILOT_SDK_PINNED_PACKAGE_KEYS) {
    const expected = expectedVersions[key];
    const actualInLock = installedLock.packages?.[key]?.version;
    if (actualInLock !== expected) {
      return {
        ok: false,
        reason: `${key} lock drift: installed=${actualInLock ?? "(missing)"}, pinned=${expected}`,
      };
    }
    const pkgJsonPath = path.join(fallbackDir, key, "package.json");
    if (!existsSync(pkgJsonPath)) {
      return { ok: false, reason: `missing installed package ${key}` };
    }
    try {
      const actualVersion = (JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string })
        .version;
      if (actualVersion !== expected) {
        return {
          ok: false,
          reason: `${key} version drift: installed=${actualVersion ?? "(missing)"}, pinned=${expected}`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason: `unreadable ${key}/package.json: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  if (stableStringifyJson(installedLock) !== stableStringifyJson(manifestLock)) {
    return {
      ok: false,
      reason: "fallback package-lock drift: installed lock does not match pinned manifest",
    };
  }

  return { ok: true };
}

export async function installCopilotSdk(
  options: InstallCopilotSdkOptions = {},
): Promise<InstallCopilotSdkResult> {
  const fallbackDir = options.fallbackDir ?? resolveCopilotSdkFallbackDir();
  const spec = options.spec ?? COPILOT_SDK_SPEC;
  const logger = options.logger ?? (() => undefined);
  const manifestDir = options.manifestDir ?? COPILOT_SDK_INSTALL_MANIFEST_DIR;

  const verify = verifyCopilotSdkInstall(fallbackDir, manifestDir);
  if (verify.ok) {
    logger(
      `[copilot] @github/copilot-sdk already installed at ${fallbackDir} (pinned graph matches)`,
    );
    return { installed: false, fallbackDir, spec };
  }
  if (isCopilotSdkInstalled(fallbackDir)) {
    // Stale, partial, or manually-placed tree. Log the drift before letting
    // `npm ci` wipe node_modules and reinstall from the pinned lock.
    logger(
      `[copilot] reinstalling Copilot SDK: ${verify.reason ?? "fallback install does not match pinned manifest"}`,
    );
  }

  mkdirSync(fallbackDir, { recursive: true });
  // Stage the pinned package.json + package-lock.json into the fallback dir
  // so the subsequent `npm ci` resolves the same dependency graph that this
  // PR was reviewed against. We intentionally overwrite any prior copies so a
  // bumped manifest in a later openclaw release re-pins user installs cleanly.
  for (const file of ["package.json", "package-lock.json"]) {
    const source = path.join(manifestDir, file);
    if (!existsSync(source)) {
      throw new Error(
        `[copilot] missing Copilot SDK install manifest at ${source}; expected the openclaw build to copy src/commands/copilot-sdk-install-manifest/`,
      );
    }
    copyFileSync(source, path.join(fallbackDir, file));
  }

  const runInstall = options.runInstall ?? defaultRunInstall;
  logger(`[copilot] installing ${spec} into ${fallbackDir} (npm ci against pinned manifest) ...`);
  await runInstall({ dir: fallbackDir, spec, manifestDir });
  const postVerify = verifyCopilotSdkInstall(fallbackDir, manifestDir);
  if (!postVerify.ok) {
    throw new Error(
      `[copilot] install of ${spec} reported success but the resulting fallback graph does not match the pinned manifest at ${manifestDir}: ${
        postVerify.reason ?? "unknown"
      }`,
    );
  }
  logger(`[copilot] installed ${spec}`);
  return { installed: true, fallbackDir, spec };
}

async function defaultRunInstall(cmd: {
  dir: string;
  spec: string;
  manifestDir: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // `npm ci` requires the lockfile we just staged into cmd.dir and refuses
    // to resolve anything outside it; this is what gives us a deterministic
    // graph across user machines. We deliberately keep install scripts
    // enabled because the @github/copilot CLI has a postinstall that pulls
    // the platform-specific binary, which is the whole reason we run npm
    // here instead of a single tarball fetch.
    const child = spawn("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: cmd.dir,
      stdio: ["ignore", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`[copilot] npm ci ${cmd.spec} exited with code ${code ?? "null"}`));
    });
  });
}

/**
 * Wizard hook called from `src/plugins/provider-auth-choice.ts` after
 * the user selects a model. If the selected model needs the Copilot
 * SDK and it is not installed, prompts the user to install it now.
 *
 * Returns `{ required: false }` and a no-op if the selection does not
 * need the SDK; this is the hot path for most model selections.
 */
export async function ensureCopilotSdkForModelSelection(params: {
  cfg: OpenClawConfig;
  model?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isInstalled?: () => boolean;
  install?: (options: InstallCopilotSdkOptions) => Promise<InstallCopilotSdkResult>;
}): Promise<CopilotSdkInstallResult> {
  if (!selectedModelShouldEnsureCopilotSdk({ cfg: params.cfg, model: params.model })) {
    return { cfg: params.cfg, required: false, installed: false };
  }

  const isInstalled =
    params.isInstalled ??
    (() =>
      verifyCopilotSdkInstall(resolveCopilotSdkFallbackDir(), COPILOT_SDK_INSTALL_MANIFEST_DIR).ok);
  if (isInstalled()) {
    return {
      cfg: params.cfg,
      required: true,
      installed: false,
      status: "already-installed",
    };
  }

  if (resolveIsNixMode()) {
    await params.prompter.note(
      "Nix mode detected (OPENCLAW_NIX_MODE=1). The Copilot agent runtime SDK cannot be auto-installed; add the pinned @github/copilot-sdk manifest dependency to the Nix-managed OpenClaw package set, then rebuild.",
      COPILOT_SDK_PACKAGE_LABEL,
    );
    return { cfg: params.cfg, required: true, installed: false, status: "nix-mode" };
  }

  const proceed = await params.prompter.confirm({
    message:
      "The Copilot agent runtime needs @github/copilot-sdk (~260 MB on first install, downloads the @github/copilot CLI binary for your platform). Install now?",
    initialValue: true,
  });

  if (!proceed) {
    await params.prompter.note(
      "Skipped. The Copilot agent runtime will fail at first invocation with an install message. Re-run setup to retry; the pinned dependency graph ships with openclaw under src/commands/copilot-sdk-install-manifest/.",
      COPILOT_SDK_PACKAGE_LABEL,
    );
    return { cfg: params.cfg, required: true, installed: false, status: "declined" };
  }

  const progress = params.prompter.progress(`Installing ${COPILOT_SDK_PACKAGE_LABEL}`);
  try {
    const installer = params.install ?? installCopilotSdk;
    const result = await installer({
      logger: (message) => {
        progress.update(message);
        params.runtime.log(message);
      },
    });
    progress.stop(result.installed ? "Installed." : "Already installed.");
    return {
      cfg: params.cfg,
      required: true,
      installed: result.installed,
      status: "installed",
    };
  } catch (err) {
    progress.stop("Install failed.");
    const message = err instanceof Error ? err.message : String(err);
    await params.prompter.note(
      `Install failed: ${message}\n\nRe-run setup to retry the install (the pinned dependency graph ships with openclaw under src/commands/copilot-sdk-install-manifest/).`,
      COPILOT_SDK_PACKAGE_LABEL,
    );
    return { cfg: params.cfg, required: true, installed: false, status: "failed" };
  }
}
