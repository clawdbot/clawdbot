import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";

export function normalizeSetupPresentationHttpsUrl(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  try {
    const url = new URL(normalized);
    const canonical = url.toString();
    return url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password &&
      canonical.length <= 2048
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}
