export function onceFrame(
  ws: unknown,
  filter: (message: Record<string, unknown>) => boolean,
  timeoutMs?: number,
): Promise<Record<string, unknown>>;
