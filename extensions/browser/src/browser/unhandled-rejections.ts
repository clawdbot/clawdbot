/**
 * Browser-specific unhandled rejection filter for benign Playwright dialog
 * races.
 */
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import { registerUnhandledRejectionHandler } from "openclaw/plugin-sdk/runtime-env";

const PLAYWRIGHT_DIALOG_METHODS = new Set([
  "Page.handleJavaScriptDialog",
  "Dialog.handleJavaScriptDialog",
]);

const NO_DIALOG_MESSAGE = "no dialog is showing";

function readMessage(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (!err || typeof err !== "object") {
    return "";
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function readPlaywrightMethod(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const method = (err as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

/** Detects Playwright "no dialog is showing" races that can escape as rejections. */
export function isPlaywrightDialogRaceUnhandledRejection(reason: unknown): boolean {
  for (const candidate of collectErrorGraphCandidates(reason, (current) => [
    current.cause,
    current.reason,
    current.original,
    current.error,
    current.data,
    ...(Array.isArray(current.errors) ? current.errors : []),
  ])) {
    const message = readMessage(candidate);
    const normalizedMessage = message.toLowerCase();
    if (!normalizedMessage.includes(NO_DIALOG_MESSAGE)) {
      continue;
    }

    const method = readPlaywrightMethod(candidate);
    if (method && PLAYWRIGHT_DIALOG_METHODS.has(method)) {
      return true;
    }
    for (const playwrightMethod of PLAYWRIGHT_DIALOG_METHODS) {
      if (message.includes(playwrightMethod)) {
        return true;
      }
    }
  }

  return false;
}

/** Installs the Browser unhandled-rejection filter and returns its disposer. */
export function registerBrowserUnhandledRejectionHandler(): () => void {
  return registerUnhandledRejectionHandler(isPlaywrightDialogRaceUnhandledRejection);
}
