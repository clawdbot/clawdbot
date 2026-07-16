const QA_LAB_API_REQUEST_TIMEOUT_MS = 30_000;

function createRequestSignal(): AbortSignal {
  return AbortSignal.timeout(QA_LAB_API_REQUEST_TIMEOUT_MS);
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { signal: createRequestSignal() });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function getJsonNoStore<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    signal: createRequestSignal(),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: createRequestSignal(),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}
