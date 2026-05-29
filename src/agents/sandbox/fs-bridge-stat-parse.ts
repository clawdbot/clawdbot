export function parseSandboxStatSize(value: string | undefined): number {
  const raw = value ?? "0";
  if (!/^\d+$/.test(raw)) {
    return 0;
  }
  const size = Number(raw);
  return Number.isFinite(size) ? size : 0;
}

export function parseSandboxStatMtimeMs(value: string | undefined): number {
  const raw = value ?? "0";
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const mtimeMs = Number(raw) * 1000;
    return Number.isFinite(mtimeMs) ? mtimeMs : 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
