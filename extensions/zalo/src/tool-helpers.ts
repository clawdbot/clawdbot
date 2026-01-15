export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean; allowEmpty?: boolean; trim?: boolean },
): string | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) {
    if (opts?.required) throw new Error(`${key} is required`);
    return undefined;
  }
  const value = String(raw);
  const trimmed = opts?.trim === false ? value : value.trim();
  if (!opts?.allowEmpty && !trimmed) {
    if (opts?.required) throw new Error(`${key} is required`);
    return undefined;
  }
  return trimmed;
}

export function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}
