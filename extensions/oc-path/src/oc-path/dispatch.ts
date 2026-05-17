/**
 * Cross-kind utilities. `inferKind` is a convention helper for callers
 * who want to map filename to the parser they should use before calling
 * the universal verbs (`resolveOcPath`, `findOcPaths`, `setOcPath`).
 *
 * Encoding remains per-kind (`parseMd`, `parseJsonc`, `parseJsonl`),
 * while addressing and mutation dispatch are universal once callers
 * have an AST carrying its `kind` discriminator.
 *
 * @module @openclaw/oc-path/dispatch
 */

export type OcKind = "md" | "jsonc" | "jsonl" | "yaml";

/**
 * Recommend a kind from a filename. Pure convention helper — returns
 * the substrate's default mapping. Consumers can override.
 */
export function inferKind(filename: string): OcKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md")) {
    return "md";
  }
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
    return "jsonl";
  }
  if (lower.endsWith(".jsonc") || lower.endsWith(".json")) {
    return "jsonc";
  }
  if (lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".lobster")) {
    return "yaml";
  }
  return null;
}
