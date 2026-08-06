export function probeHttpStatus({
  url,
  expectedRaw,
  timeoutMs,
  bearer,
  fetchImpl,
}: {
  url: unknown;
  expectedRaw?: string | undefined;
  timeoutMs?: number | undefined;
  bearer?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<boolean>;
