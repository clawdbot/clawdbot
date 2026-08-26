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
