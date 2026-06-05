/**
 * Shared helpers for Browser CLI action subcommands.
 */
import fs from "node:fs/promises";
import type { Command } from "commander";
import { callBrowserRequest, type BrowserParentOpts } from "../browser-cli-shared.js";
import {
  danger,
  defaultRuntime,
  normalizeBrowserFormField,
  normalizeBrowserFormFieldValue,
  type BrowserFormField,
} from "../core-api.js";

type BrowserActionContext = {
  parent: BrowserParentOpts;
  profile: string | undefined;
};

const BROWSER_ACTION_TIMEOUT_SLACK_MS = 5000;
const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 20000;

/** Adds gateway slack to a Browser action timeout so route work can finish cleanly. */
export function withBrowserActionTimeoutSlack(timeoutMs: number | undefined): number {
  return (
    Math.max(1, Math.floor(timeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS)) +
    BROWSER_ACTION_TIMEOUT_SLACK_MS
  );
}

/** Resolves inherited Browser action context from a commander command. */
export function resolveBrowserActionContext(
  cmd: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
): BrowserActionContext {
  const parent = parentOpts(cmd);
  const profile = parent?.browserProfile;
  return { parent, profile };
}

/** Calls the Browser /act route for one CLI action body. */
export async function callBrowserAct<T = unknown>(params: {
  parent: BrowserParentOpts;
  profile?: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<T> {
  return await callBrowserRequest<T>(
    params.parent,
    {
      method: "POST",
      path: "/act",
      query: params.profile ? { profile: params.profile } : undefined,
      body: params.body,
    },
    { timeoutMs: withBrowserActionTimeoutSlack(params.timeoutMs) },
  );
}

/** Writes Browser action output as JSON or a terse success message. */
export function logBrowserActionResult(
  parent: BrowserParentOpts,
  result: unknown,
  successMessage: string,
) {
  if (parent?.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(successMessage);
}

/** Requires and trims an element ref, exiting through the CLI runtime on failure. */
export function requireRef(ref: string | undefined) {
  const refValue = typeof ref === "string" ? ref.trim() : "";
  if (!refValue) {
    defaultRuntime.error(danger("ref is required"));
    defaultRuntime.exit(1);
    return null;
  }
  return refValue;
}

async function readFile(path: string): Promise<string> {
  return await fs.readFile(path, "utf8");
}

/** Reads and validates JSON form-field descriptors from inline text or a file. */
export async function readFields(opts: {
  fields?: string;
  fieldsFile?: string;
}): Promise<BrowserFormField[]> {
  const payload = opts.fieldsFile ? await readFile(opts.fieldsFile) : (opts.fields ?? "");
  if (!payload.trim()) {
    throw new Error("fields are required");
  }
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("fields must be an array");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`fields[${index}] must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    const parsedField = normalizeBrowserFormField(rec);
    if (!parsedField) {
      throw new Error(`fields[${index}] must include ref`);
    }
    if (
      rec.value === undefined ||
      rec.value === null ||
      normalizeBrowserFormFieldValue(rec.value) !== undefined
    ) {
      return parsedField;
    }
    throw new Error(`fields[${index}].value must be string, number, boolean, or null`);
  });
}
