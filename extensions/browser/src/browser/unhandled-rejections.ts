import { registerUnhandledRejectionHandler } from "openclaw/plugin-sdk/runtime-env";

const PLAYWRIGHT_DIALOG_METHODS = new Set([
  "Page.handleJavaScriptDialog",
  "Dialog.handleJavaScriptDialog",
]);

const NO_DIALOG_MESSAGE = "no dialog is showing";

function collectNestedErrorCandidates(err: unknown): unknown[] {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (!current || typeof current !== "object") {
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const nested of [
      record.cause,
      record.reason,
      record.original,
      record.error,
      record.data,
    ]) {
      if (nested != null && !seen.has(nested)) {
        queue.push(nested);
      }
    }
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) {
        if (nested != null && !seen.has(nested)) {
          queue.push(nested);
        }
      }
    }
  }

  return candidates;
}

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

export function isPlaywrightDialogRaceUnhandledRejection(reason: unknown): boolean {
  for (const candidate of collectNestedErrorCandidates(reason)) {
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

export function registerBrowserUnhandledRejectionHandler(): () => void {
  return registerUnhandledRejectionHandler(isPlaywrightDialogRaceUnhandledRejection);
}
