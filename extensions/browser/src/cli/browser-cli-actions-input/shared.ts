/**
 * Shared helpers for Browser CLI action subcommands.
 */
import fs from "node:fs/promises";
import type { Command } from "commander";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { BROWSER_ACTION_TRANSPORT_SLACK_MS } from "../../browser/act-policy.js";
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

const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 20000;

/** Adds gateway slack to a Browser action timeout so route work can finish cleanly. */
export function withBrowserActionTimeoutSlack(timeoutMs: number | undefined): number {
  return (
    addTimerTimeoutGraceMs(
      timeoutMs ?? DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
      BROWSER_ACTION_TRANSPORT_SLACK_MS,
    ) ?? 1
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new Error("fields must be valid JSON.", { cause });
  }
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

/** Cap on batch action JSON read from stdin; keeps a runaway pipe from filling memory. */
const ACTIONS_STDIN_MAX_BYTES = 1_000_000;

/** Reads stdin to a UTF-8 string, throwing once the byte cap is exceeded. */
async function readStdinText(
  stream: NodeJS.ReadableStream = process.stdin,
  maxBytes = ACTIONS_STDIN_MAX_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`actions stdin exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads raw batch actions JSON from inline text, a file path, or stdin (`-`). */
export async function readActionsPayload(opts: {
  actions?: string;
  actionsFile?: string;
}): Promise<string> {
  if (opts.actionsFile) {
    return opts.actionsFile === "-" ? await readStdinText() : await readFile(opts.actionsFile);
  }
  return opts.actions ?? "";
}
