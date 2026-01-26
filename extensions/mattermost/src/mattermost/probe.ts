import { normalizeMattermostBaseUrl, type MattermostUser } from "./client.js";

export type MattermostProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs?: number | null;
  bot?: MattermostUser;
};

async function readMattermostError(res: Response): Promise<string> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as { message?: string } | undefined;
    if (data?.message) return data.message;
    return JSON.stringify(data);
  }
  return await res.text();
}

export async function probeMattermost(
  baseUrl: string,
  botToken: string,
  timeoutMs = 2500,
): Promise<MattermostProbe> {
  const normalized = normalizeMattermostBaseUrl(baseUrl);
  if (!normalized) {
    return { ok: false, error: "baseUrl missing" };
  }
  const url = `${normalized}/api/v4/users/me`;
  const start = Date.now();
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  let timer: NodeJS.Timeout | null = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: controller?.signal,
    });
    const elapsedMs = Date.now() - start;
    if (!res.ok) {
      const detail = await readMattermostError(res);
      return {
        ok: false,
        status: res.status,
        error: detail || res.statusText,
        elapsedMs,
      };
    }
    const bot = (await res.json()) as MattermostUser;
    return {
      ok: true,
      status: res.status,
      elapsedMs,
      bot,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: null,
      error: message,
      elapsedMs: Date.now() - start,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
