import { fetchWithSsrFGuard } from "../../../api.js";

type GuardedJsonApiRequestParams = {
  url: string;
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  allowNotFound?: boolean;
  allowedHostnames: string[];
  auditContext: string;
  errorPrefix: string;
};

export async function guardedJsonApiRequest<T = unknown>(
  params: GuardedJsonApiRequestParams,
): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: {
      method: params.method,
      headers: params.headers,
      body: params.body ? JSON.stringify(params.body) : undefined,
    },
    policy: { allowedHostnames: params.allowedHostnames },
    auditContext: params.auditContext,
  });

  try {
    if (!response.ok) {
      if (params.allowNotFound && response.status === 404) {
        return undefined as T;
      }
      const errorText = await response.text();
      throw new Error(`${params.errorPrefix}: ${response.status} ${errorText}`);
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${params.errorPrefix}: malformed JSON response`);
    }
  } finally {
    await release();
  }
}
