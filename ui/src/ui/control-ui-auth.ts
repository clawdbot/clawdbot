import { normalizeOptionalString } from "./string-coerce.ts";

type ControlUiAuthSource = {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

export function resolveControlUiAuthToken(source: ControlUiAuthSource): string | null {
  return (
    normalizeOptionalString(source.hello?.auth?.deviceToken) ??
    normalizeOptionalString(source.settings?.token) ??
    normalizeOptionalString(source.password) ??
    null
  );
}

export function resolveControlUiAuthHeader(source: ControlUiAuthSource): string | null {
  const token = resolveControlUiAuthToken(source);
  return token ? `Bearer ${token}` : null;
}
