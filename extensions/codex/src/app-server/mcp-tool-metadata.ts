import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

/** Hosted app ownership is authoritative only on metadata supplied by Codex. */
export function readCodexMcpToolConnectorId(tool: unknown): string | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(tool)?.["_meta"]);
  return (
    normalizeOptionalString(metadata?.connector_id) ??
    normalizeOptionalString(metadata?.connectorId)
  );
}

/**
 * Connector name Codex derives the `codex_apps` tool namespace from:
 * `connector_name`, then `connector_display_name` (rmcp-client, rust-v0.153.4).
 */
export function readCodexMcpToolConnectorName(tool: unknown): string | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(tool)?.["_meta"]);
  return (
    normalizeOptionalString(metadata?.connector_name) ??
    normalizeOptionalString(metadata?.connectorName) ??
    normalizeOptionalString(metadata?.connector_display_name) ??
    normalizeOptionalString(metadata?.connectorDisplayName)
  );
}

/** Preserve MCP App visibility so model-only tools cannot become widget authority. */
export function readCodexMcpToolUiVisibility(tool: unknown): Array<"app" | "model"> | undefined {
  const metadata = asOptionalRecord(asOptionalRecord(tool)?.["_meta"]);
  const visibility = asOptionalRecord(metadata?.ui)?.visibility;
  if (!Array.isArray(visibility)) {
    return undefined;
  }
  return [
    ...new Set(
      visibility.filter((value): value is "app" | "model" => value === "app" || value === "model"),
    ),
  ].toSorted();
}
