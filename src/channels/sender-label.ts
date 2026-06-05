// Sender display-label helpers shared by channel ingress and audit surfaces.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type SenderLabelParams = {
  name?: string;
  username?: string;
  tag?: string;
  e164?: string;
  id?: string;
};

function normalizeSenderLabelParams(params: SenderLabelParams) {
  return {
    name: normalizeOptionalString(params.name),
    username: normalizeOptionalString(params.username),
    tag: normalizeOptionalString(params.tag),
    e164: normalizeOptionalString(params.e164),
    id: normalizeOptionalString(params.id),
  };
}

/** Resolves the best one-line sender label from available identity fields. */
export function resolveSenderLabel(params: SenderLabelParams): string | null {
  const { name, username, tag, e164, id } = normalizeSenderLabelParams(params);

  const display = name ?? username ?? tag ?? "";
  const idPart = e164 ?? id ?? "";
  if (display && idPart && display !== idPart) {
    return `${display} (${idPart})`;
  }
  return display || idPart || null;
}

/** Returns de-duplicated sender label candidates for matching and search. */
export function listSenderLabelCandidates(params: SenderLabelParams): string[] {
  const candidates = new Set<string>();
  const { name, username, tag, e164, id } = normalizeSenderLabelParams(params);

  if (name) {
    candidates.add(name);
  }
  if (username) {
    candidates.add(username);
  }
  if (tag) {
    candidates.add(tag);
  }
  if (e164) {
    candidates.add(e164);
  }
  if (id) {
    candidates.add(id);
  }
  const resolved = resolveSenderLabel(params);
  if (resolved) {
    candidates.add(resolved);
  }
  return Array.from(candidates);
}
