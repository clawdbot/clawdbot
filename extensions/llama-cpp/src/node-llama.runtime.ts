import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type NodeLlamaCppModule = typeof import("node-llama-cpp");

function isNodeLlamaCppMissing(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" && error.message.includes("node-llama-cpp");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatLlamaCppSetupError(error: unknown): string {
  const detail = formatErrorMessage(error);
  const missing = isNodeLlamaCppMissing(error);
  return [
    "Local llama.cpp is unavailable.",
    missing
      ? "Reason: node-llama-cpp is missing or failed to install."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local GGUF models:",
    "1) Install the official provider plugin: openclaw plugins install @openclaw/llama-cpp-provider",
    "2) Use Node 24 for native installs/updates.",
    "3) If you use pnpm from source: pnpm approve-builds, then pnpm rebuild node-llama-cpp.",
  ]
    .filter(Boolean)
    .join("\n");
}

const requireFromPlugin = createRequire(import.meta.url);

export function resolveNodeLlamaCppImportUrl(): string {
  return pathToFileURL(requireFromPlugin.resolve("node-llama-cpp")).href;
}

export async function importNodeLlamaCpp(): Promise<NodeLlamaCppModule> {
  // Keep this runtime-resolved: bundling node-llama-cpp rewrites its import.meta.url,
  // which makes its package-relative native assets resolve from the OpenClaw bundle.
  return await import(resolveNodeLlamaCppImportUrl());
}
