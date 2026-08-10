/**
 * Validation for the tool set a browser declares on an AG-UI request.
 *
 * Everything here runs BEFORE the run is admitted, so a bad tool set gets the
 * documented JSON 400 rather than a committed SSE stream that fails mid-run
 * with a session entry already written.
 */

import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  type OpenAIToolSchema,
  type StateWriterSpec,
  parseStateWriterTools,
} from "./prompt-builder.js";

/**
 * Ceiling on browser-declared tool schemas, which reach the model as tool
 * definitions. Companion to the `context`/`state` caps in prompt-builder.ts —
 * the request body limit alone (~1 MiB) would let one page spend the agent's
 * whole context window on tool definitions.
 */
const MAX_CLIENT_TOOL_SCHEMA_CHARS = 24_000;

export interface DeclaredTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

type DeclaredToolsResult = { ok: true; tools: DeclaredTool[] } | { ok: false; message: string };

/**
 * Validates the browser-declared `tools` array before the run is admitted.
 *
 * Mirrors the invariant core enforces on the equivalent surface
 * (`extractClientToolsFromChatRequest`, src/gateway/openai-http.ts): tools must
 * be an array, every entry an object, and every entry must name a tool. Doing
 * this up front is what keeps a malformed payload on the documented 400 path
 * instead of failing later as a committed SSE stream.
 *
 * `parameters` is held to the same record check as a state-writer schema, for
 * the same reason: an array satisfies a bare `typeof === "object"` and would
 * otherwise ride through as a tool schema the model cannot use. Core drops a
 * non-record `parameters` silently at its own boundary; this surface names the
 * error, because a tool that reaches the model with its schema quietly removed
 * is a worse outcome for the page than a 400 that says what to fix.
 */
function parseDeclaredTools(rawTools: unknown): DeclaredToolsResult {
  if (rawTools == null) {
    return { ok: true, tools: [] };
  }
  if (!Array.isArray(rawTools)) {
    return { ok: false, message: "`tools` must be an array." };
  }
  const tools: DeclaredTool[] = [];
  for (const [index, tool] of rawTools.entries()) {
    if (!isRecord(tool)) {
      return { ok: false, message: `\`tools[${index}]\` must be an object.` };
    }
    const rawName = tool.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) {
      return { ok: false, message: `\`tools[${index}].name\` is required.` };
    }
    const { description, parameters } = tool;
    if (parameters !== undefined && !isRecord(parameters)) {
      return { ok: false, message: `\`tools[${index}].parameters\` must be a JSON Schema object.` };
    }
    tools.push({
      name,
      ...(typeof description === "string" ? { description } : {}),
      ...(parameters ? { parameters } : {}),
    });
  }
  return { ok: true, tools };
}

/**
 * Names that collide within the tool set this handler hands to the model:
 * the browser's declared tools plus the state-writer tools we inject.
 *
 * Compares case-insensitively on the trimmed name. It deliberately does NOT
 * reimplement core's tool-name normalization (`normalizeToolName` applies an
 * alias table): duplicating that policy in a plugin would silently drift from
 * core. Collisions with core's own builtin/reserved tool names are therefore
 * still caught by core rather than here — closing that half needs a plugin-SDK
 * seam for the shared conflict rule, which does not exist today.
 */
function findDeclaredToolConflicts(declaredNames: string[], stateWriterNames: string[]): string[] {
  // Walk the COMBINED set, not just the declared half: two state writers can
  // share a name as easily as two declared tools, and both halves are injected
  // into the same clientTools array.
  const conflicts = new Set<string>();
  const seen = new Map<string, string>();
  for (const raw of [...declaredNames, ...stateWriterNames]) {
    const key = raw.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const prior = seen.get(key);
    if (prior) {
      conflicts.add(prior);
      conflicts.add(raw);
      continue;
    }
    seen.set(key, raw);
  }
  return Array.from(conflicts);
}

type RequestToolsetResult =
  | {
      ok: true;
      declaredTools: DeclaredTool[];
      stateWriterSpecs: Map<string, StateWriterSpec>;
      stateWriterSchemas: OpenAIToolSchema[];
    }
  | { ok: false; message: string };

/**
 * Resolves everything the model's tool list depends on, or names the first
 * problem with it. The caller runs this before admitting the run and turns a
 * rejection into the documented JSON 400.
 *
 * The two halves are validated together because they are injected together: the
 * set the model receives is the browser's declared tools PLUS the state-writer
 * tools this channel injects, so neither the name conflicts nor the size cap can
 * be judged from one half alone. Core catches a bad set too, but only inside the
 * run — after SSE is committed and the session may already be upserted — which
 * turns the documented 400 into a 200 with a RUN_ERROR on a live stream.
 */
export function validateRequestToolset(
  rawTools: unknown,
  forwardedProps: unknown,
): RequestToolsetResult {
  const stateWriters = parseStateWriterTools(forwardedProps);
  if (!stateWriters.ok) {
    return stateWriters;
  }
  const declared = parseDeclaredTools(rawTools);
  if (!declared.ok) {
    return declared;
  }
  const { specs: stateWriterSpecs, schemas: stateWriterSchemas } = stateWriters;

  const conflicts = findDeclaredToolConflicts(
    declared.tools.map((t) => t.name),
    stateWriterSchemas.map((s) => s.function.name),
  );
  if (conflicts.length > 0) {
    return {
      ok: false,
      message: `Conflicting tool names: ${conflicts.join(", ")}. Each declared tool needs a distinct name, and none may collide with a declared state-writer tool.`,
    };
  }

  const chars = JSON.stringify(declared.tools).length + JSON.stringify(stateWriterSchemas).length;
  if (chars > MAX_CLIENT_TOOL_SCHEMA_CHARS) {
    return {
      ok: false,
      message: `Declared tool schemas are too large (${chars} chars, limit ${MAX_CLIENT_TOOL_SCHEMA_CHARS}). Send fewer tools or shorter descriptions/parameter schemas.`,
    };
  }

  return { ok: true, declaredTools: declared.tools, stateWriterSpecs, stateWriterSchemas };
}
