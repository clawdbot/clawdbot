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

// Matches opaque profile/device UUIDs. A phone number or handle in the id
// position disambiguates a human label; a UUID is machine noise, so it never
// belongs in a display label suffix.
const OPAQUE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Resolves the best one-line sender label from available identity fields. */
export function resolveSenderLabel(params: SenderLabelParams): string | null {
  const { name, username, tag, e164, id } = normalizeSenderLabelParams(params);

  const display = name ?? username ?? tag ?? "";
  const idPart = e164 ?? id ?? "";
  if (display && idPart && display !== idPart && !OPAQUE_UUID_RE.test(idPart)) {
    return `${display} (${idPart})`;
  }
  return display || idPart || null;
}
