import path from "node:path";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  WorkspaceBindingResolutionError,
  normalizeWorkspaceDataLogicalPath,
} from "./binding-contract.js";
import type { WorkspaceBinding, JsonValue } from "./schema.js";

export { DATA_READ_RPC_ALLOWLIST, WorkspaceBindingResolutionError } from "./binding-contract.js";

export type ResolveBindingOptions = {
  stateDir?: string;
};

const MAX_FILE_BYTES = 1024 * 1024;
const JSON_POINTER_ARRAY_INDEX_SEGMENT = /^(?:0|[1-9]\d*)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBinding(value: unknown): WorkspaceBinding {
  if (!isRecord(value) || typeof value.source !== "string") {
    throw new WorkspaceBindingResolutionError("binding_invalid", "binding source is required");
  }
  if (value.source === "static") {
    return { source: "static", value: value.value as JsonValue };
  }
  if (value.source === "rpc") {
    if (typeof value.method !== "string" || !value.method.trim()) {
      throw new WorkspaceBindingResolutionError(
        "binding_invalid",
        "rpc binding method is required",
      );
    }
    const params = isRecord(value.params) ? (value.params as Record<string, JsonValue>) : undefined;
    return { source: "rpc", method: value.method, ...(params ? { params } : {}) };
  }
  if (value.source === "file") {
    if (typeof value.path !== "string") {
      throw new WorkspaceBindingResolutionError("binding_invalid", "file binding path is required");
    }
    if (value.pointer !== undefined && typeof value.pointer !== "string") {
      throw new WorkspaceBindingResolutionError(
        "binding_invalid",
        "file binding pointer is invalid",
      );
    }
    return {
      source: "file",
      path: value.path,
      ...(value.pointer !== undefined ? { pointer: value.pointer } : {}),
    };
  }
  throw new WorkspaceBindingResolutionError("binding_invalid", "binding source is invalid");
}

function decodePointerSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function parseJsonPointerArrayIndex(segment: string): number | undefined {
  // RFC 6901 array tokens are canonical decimal indices; object tokens remain opaque keys.
  if (!JSON_POINTER_ARRAY_INDEX_SEGMENT.test(segment)) {
    return undefined;
  }
  const index = Number(segment);
  return Number.isSafeInteger(index) ? index : undefined;
}

function applyJsonPointer(value: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined || pointer === "") {
    return value;
  }
  if (!pointer.startsWith("/")) {
    throw new WorkspaceBindingResolutionError("binding_invalid", "JSON pointer is invalid");
  }
  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (Array.isArray(current)) {
      const index = parseJsonPointerArrayIndex(segment);
      if (index === undefined || index >= current.length) {
        throw new WorkspaceBindingResolutionError("binding_not_found", "JSON pointer not found");
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      throw new WorkspaceBindingResolutionError("binding_not_found", "JSON pointer not found");
    }
    current = current[segment];
  }
  return current;
}

async function resolveFileBinding(
  binding: Extract<WorkspaceBinding, { source: "file" }>,
  options: ResolveBindingOptions,
): Promise<unknown> {
  const logicalPath = normalizeWorkspaceDataLogicalPath(binding.path);
  const stateDir = path.resolve(options.stateDir ?? resolveStateDir());
  const dataRoot = path.join(stateDir, "workspaces", "data");
  let content: string;
  try {
    const state = await fsRoot(stateDir);
    const data = await fsRoot(dataRoot);
    const expectedDataRoot = path.join(state.rootReal, "workspaces", "data");
    // The data directory itself is part of the jail, not a trusted alias. Once
    // this matches, fs-safe pins its canonical root and rejects later swaps.
    if (data.rootReal !== expectedDataRoot) {
      throw new WorkspaceBindingResolutionError("binding_invalid", "file binding path is invalid");
    }
    // The schema rejects leading `~/`, so this absolute path never invokes the
    // shared root helper's home-expansion convenience.
    const read = await data.readAbsolute(path.join(data.rootDir, logicalPath), {
      hardlinks: "reject",
      maxBytes: MAX_FILE_BYTES,
      symlinks: "reject",
    });
    content = read.buffer.toString("utf8");
  } catch (error) {
    if (error instanceof FsSafeError) {
      if (error.code === "too-large") {
        throw new WorkspaceBindingResolutionError("binding_too_large", "file binding is too large");
      }
      if (error.code === "not-found" || error.code === "not-file") {
        throw new WorkspaceBindingResolutionError("binding_not_found", "file binding not found");
      }
      throw new WorkspaceBindingResolutionError("binding_invalid", "file binding path is invalid");
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceBindingResolutionError("binding_not_found", "file binding not found");
    }
    throw error;
  }
  const extension = path.extname(logicalPath).toLowerCase();
  if (extension === ".md" || extension === ".csv") {
    return content;
  }
  try {
    return applyJsonPointer(JSON.parse(content), binding.pointer);
  } catch (error) {
    if (error instanceof WorkspaceBindingResolutionError) {
      throw error;
    }
    throw new WorkspaceBindingResolutionError("binding_invalid", "file binding JSON is invalid");
  }
}

export async function resolveBinding(
  bindingInput: unknown,
  options: ResolveBindingOptions = {},
): Promise<unknown> {
  const binding = readBinding(bindingInput);
  if (binding.source === "static") {
    return binding.value;
  }
  if (binding.source === "rpc") {
    throw new WorkspaceBindingResolutionError(
      "binding_client_resolved",
      "rpc workspace bindings are resolved by the Control UI gateway client",
    );
  }
  return await resolveFileBinding(binding, options);
}
