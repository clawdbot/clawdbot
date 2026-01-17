import { buildBlueBubblesApiUrl, blueBubblesFetchWithTimeout } from "./types.js";

export type BlueBubblesProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
};

export async function probeBlueBubbles(params: {
  baseUrl?: string | null;
  password?: string | null;
  timeoutMs?: number;
}): Promise<BlueBubblesProbe> {
  const baseUrl = params.baseUrl?.trim();
  const password = params.password?.trim();
  if (!baseUrl) return { ok: false, error: "serverUrl not configured" };
  if (!password) return { ok: false, error: "password not configured" };
  const url = buildBlueBubblesApiUrl({ baseUrl, path: "/api/v1/ping", password });
  try {
    const res = await blueBubblesFetchWithTimeout(
      url,
      { method: "GET" },
      params.timeoutMs,
    );
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
