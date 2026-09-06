import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../api/types.ts";
import { parseAgentSessionKey } from "./sessions/session-key.ts";

export function resolveSessionRenameValue(
  row: Pick<GatewaySessionRow, "key" | "label" | "displayName" | "derivedTitle" | "worktree">,
): string {
  const label = normalizeOptionalString(row.label);
  // Dashboard titles are editable session text; channel/account decoration is not.
  const generatedTitle = parseAgentSessionKey(row.key)?.rest.startsWith("dashboard:")
    ? (normalizeOptionalString(row.displayName) ??
      (row.worktree ? undefined : normalizeOptionalString(row.derivedTitle)))
    : undefined;
  return label ?? generatedTitle ?? "";
}

export function resolveSessionRenamePatch(
  value: string,
  initialValue: string,
  storedLabel: string | undefined,
): { label: string | null } | null {
  const label = normalizeOptionalString(value) ?? null;
  // Merely accepting a generated title must not freeze it as a manual label.
  return label === (normalizeOptionalString(initialValue) ?? null) ||
    label === (normalizeOptionalString(storedLabel) ?? null)
    ? null
    : { label };
}
