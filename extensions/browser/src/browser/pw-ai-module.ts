/**
 * Optional Playwright AI module loader.
 *
 * Lazily imports the Playwright-backed browser helpers while allowing routes to
 * soft-fail when the dependency is unavailable in a gateway build.
 */
import { extractErrorCode, formatErrorMessage } from "../infra/errors.js";

/** Type of the Playwright-backed browser helper module. */
export type PwAiModule = (typeof import("./pw-ai.js"))["pwAi"];

type PwAiLoadMode = "soft" | "strict";

let pwAiModuleSoft: Promise<PwAiModule | null> | null = null;
let pwAiModuleStrict: Promise<PwAiModule | null> | null = null;
let loadedPwAiModule: PwAiModule | null | undefined;

function isModuleNotFoundError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (code === "ERR_MODULE_NOT_FOUND") {
    return true;
  }
  const msg = formatErrorMessage(err);
  return (
    msg.includes("Cannot find module") ||
    msg.includes("Cannot find package") ||
    msg.includes("Failed to resolve import") ||
    msg.includes("Failed to resolve entry for package") ||
    msg.includes("Failed to load url")
  );
}

async function loadPwAiModule(mode: PwAiLoadMode): Promise<PwAiModule | null> {
  try {
    const { pwAi } = await import("./pw-ai.js");
    loadedPwAiModule = pwAi;
    return pwAi;
  } catch (err) {
    if (mode === "soft") {
      loadedPwAiModule = null;
      return null;
    }
    if (isModuleNotFoundError(err)) {
      loadedPwAiModule = null;
      return null;
    }
    throw err;
  }
}

/** Return the already-resolved module without yielding during lifecycle invalidation. */
export function getLoadedPwAiModule(): PwAiModule | null | undefined {
  return loadedPwAiModule;
}

/** Load the Playwright AI helper module in soft or strict mode. */
export async function getPwAiModule(opts?: { mode?: PwAiLoadMode }): Promise<PwAiModule | null> {
  const mode: PwAiLoadMode = opts?.mode ?? "soft";
  if (mode === "soft") {
    if (!pwAiModuleSoft) {
      pwAiModuleSoft = loadPwAiModule("soft");
    }
    return await pwAiModuleSoft;
  }
  if (!pwAiModuleStrict) {
    pwAiModuleStrict = loadPwAiModule("strict");
  }
  return await pwAiModuleStrict;
}
