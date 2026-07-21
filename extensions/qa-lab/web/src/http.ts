const QA_LAB_API_REQUEST_TIMEOUT_MS = 30_000;

function createRequestSignal(): AbortSignal {
  return AbortSignal.timeout(QA_LAB_API_REQUEST_TIMEOUT_MS);
}

async function readJsonResponse<T>(response: Response, label: string): Promise<T> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && contentType !== "application/json" && !contentType.endsWith("+json")) {
    throw new Error(`${label}: expected JSON response`);
  }
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`${label}: empty JSON response`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`${label}: malformed JSON response`, { cause });
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { signal: createRequestSignal() });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return await readJsonResponse<T>(response, path);
}

export async function getJsonNoStore<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    signal: createRequestSignal(),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return await readJsonResponse<T>(response, path);
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: createRequestSignal(),
  });
  if (!response.ok) {
    const payload: { error?: string } = await readJsonResponse<{ error?: string }>(
      response,
      path,
    ).catch(() => ({}));
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return await readJsonResponse<T>(response, path);
}
