import type { Command } from "commander";
import type { BrowserFormField } from "../../browser/client-actions-core.js";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { callBrowserRequest, type BrowserParentOpts } from "../browser-cli-shared.js";

export type BrowserActionContext = {
  parent: BrowserParentOpts;
  profile: string | undefined;
};

export function resolveBrowserActionContext(
  cmd: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
): BrowserActionContext {
  const parent = parentOpts(cmd);
  const profile = parent?.browserProfile;
  return { parent, profile };
}

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
    { timeoutMs: params.timeoutMs ?? 20000 },
  );
}

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
  const fs = await import("node:fs/promises");
  return await fs.readFile(path, "utf8");
}

export async function readFields(opts: {
  fields?: string;
  fieldsFile?: string;
}): Promise<BrowserFormField[]> {
  const payload = opts.fieldsFile ? await readFile(opts.fieldsFile) : (opts.fields ?? "");
  if (!payload.trim()) throw new Error("fields are required");
  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) throw new Error("fields must be an array");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`fields[${index}] must be an object`);
    }
    const rec = entry as Record<string, unknown>;
    const ref = typeof rec.ref === "string" ? rec.ref.trim() : "";
    const type = typeof rec.type === "string" ? rec.type.trim() : "";
    if (!ref || !type) {
      throw new Error(`fields[${index}] must include ref and type`);
    }
    if (
      typeof rec.value === "string" ||
      typeof rec.value === "number" ||
      typeof rec.value === "boolean"
    ) {
      return { ref, type, value: rec.value };
    }
    if (rec.value === undefined || rec.value === null) {
      return { ref, type };
    }
    throw new Error(`fields[${index}].value must be string, number, boolean, or null`);
  });
}
