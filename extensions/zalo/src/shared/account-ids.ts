export const DEFAULT_ACCOUNT_ID = "default";

export function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_ACCOUNT_ID;
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return trimmed;
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || DEFAULT_ACCOUNT_ID
  );
}
