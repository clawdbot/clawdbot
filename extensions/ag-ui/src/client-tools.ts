/**
 * Validation for the tool set a browser declares on an AG-UI request.
 *
 * Everything here runs BEFORE the run is admitted, so a bad tool set gets the
 * documented JSON 400 rather than a committed SSE stream that fails mid-run
 * with a session entry already written.
 */

/**
 * Ceiling on browser-declared tool schemas, which reach the model as tool
 * definitions. Companion to the `context`/`state` caps in prompt-builder.ts —
 * the request body limit alone (~1 MiB) would let one page spend the agent's
 * whole context window on tool definitions.
 */
export const MAX_CLIENT_TOOL_SCHEMA_CHARS = 24_000;

type DeclaredToolsResult =
  | { ok: true; tools: Array<{ name: string; description?: string; parameters?: unknown }> }
  | { ok: false; message: string };

/**
 * Validates the browser-declared `tools` array before the run is admitted.
 *
 * Mirrors the invariant core enforces on the equivalent surface
 * (`extractClientToolsFromChatRequest`, src/gateway/openai-http.ts): tools must
 * be an array, every entry an object, and every entry must name a tool. Doing
 * this up front is what keeps a malformed payload on the documented 400 path
 * instead of failing later as a committed SSE stream.
 */
export function parseDeclaredTools(rawTools: unknown): DeclaredToolsResult {
  if (rawTools == null) {
    return { ok: true, tools: [] };
  }
  if (!Array.isArray(rawTools)) {
    return { ok: false, message: "`tools` must be an array." };
  }
  const tools: Array<{ name: string; description?: string; parameters?: unknown }> = [];
  for (const [index, tool] of rawTools.entries()) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      return { ok: false, message: `\`tools[${index}]\` must be an object.` };
    }
    const rawName = (tool as { name?: unknown }).name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) {
      return { ok: false, message: `\`tools[${index}].name\` is required.` };
    }
    const description = (tool as { description?: unknown }).description;
    tools.push({
      name,
      ...(typeof description === "string" ? { description } : {}),
      parameters: (tool as { parameters?: unknown }).parameters,
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
export function findDeclaredToolConflicts(
  declaredNames: string[],
  stateWriterNames: string[],
): string[] {
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
