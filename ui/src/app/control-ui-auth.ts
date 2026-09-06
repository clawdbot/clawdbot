import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

type ControlUiAuthSource = {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

// Saved tokens and passwords are Bearer credentials too. Keep them after the
// live device token so callers can recover from a rejected credential.
export function resolveControlUiAuthCandidates(source: ControlUiAuthSource): string[] {
  return normalizeUniqueTrimmedStringList([
    source.hello?.auth?.deviceToken,
    source.settings?.token,
    source.password,
  ]).filter((token) => !/[\r\n]/.test(token));
}

export function resolveControlUiAuthToken(source: ControlUiAuthSource): string | null {
  return resolveControlUiAuthCandidates(source)[0] ?? null;
}

export function resolveControlUiAuthHeader(source: ControlUiAuthSource): string | null {
  const token = resolveControlUiAuthToken(source);
  return token ? `Bearer ${token}` : null;
}
