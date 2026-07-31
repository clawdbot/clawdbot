/** Commands for managing text model fallbacks (global defaults or per agent). */
import type { RuntimeEnv } from "../../runtime.js";
import {
  addFallbackCommand,
  clearFallbacksCommand,
  listFallbacksCommand,
  removeFallbackCommand,
} from "./fallbacks-shared.js";

/** Lists configured text model fallbacks. */
export async function modelsFallbacksListCommand(
  opts: { json?: boolean; plain?: boolean; agent?: string },
  runtime: RuntimeEnv,
) {
  return await listFallbacksCommand({ label: "Fallbacks", key: "model" }, opts, runtime);
}

/** Adds a text model fallback. */
export async function modelsFallbacksAddCommand(
  modelRaw: string,
  opts: { agent?: string },
  runtime: RuntimeEnv,
) {
  return await addFallbackCommand(
    { label: "Fallbacks", key: "model", logPrefix: "Fallbacks" },
    modelRaw,
    opts,
    runtime,
  );
}

/** Removes a text model fallback. */
export async function modelsFallbacksRemoveCommand(
  modelRaw: string,
  opts: { agent?: string },
  runtime: RuntimeEnv,
) {
  return await removeFallbackCommand(
    {
      label: "Fallbacks",
      key: "model",
      notFoundLabel: "Fallback",
      logPrefix: "Fallbacks",
    },
    modelRaw,
    opts,
    runtime,
  );
}

/** Clears all text model fallbacks. */
export async function modelsFallbacksClearCommand(opts: { agent?: string }, runtime: RuntimeEnv) {
  return await clearFallbacksCommand(
    { key: "model", clearedMessage: "Fallback list cleared." },
    opts,
    runtime,
  );
}
