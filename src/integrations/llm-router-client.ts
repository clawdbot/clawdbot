export type LlmRouterSelectionResponse = {
  task_type: string;
  confidence: number;
  selected_provider: string;
  selected_model: string;
  fallback_provider?: string;
  fallback_model?: string;
};

const DEFAULT_LLM_ROUTER_URL = "http://127.0.0.1:3101";

function resolveBaseUrl(): string {
  return (process.env.LLM_ROUTER_URL ?? DEFAULT_LLM_ROUTER_URL).trim().replace(/\/$/, "");
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  return JSON.parse(text) as unknown;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${resolveBaseUrl()}${path}`, init);
  const payload = await parseJson(response);
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `llm-router request failed (${response.status})`;
    throw new Error(error);
  }
  return payload;
}

export function shouldUseLlmRouter(): boolean {
  return (process.env.OPENCLAW_LLM_TRANSPORT ?? "internal").trim().toLowerCase() === "llm-router";
}

export async function llmRouterHealth(): Promise<{ status: string }> {
  return (await request("/llm/health")) as { status: string };
}

export async function llmRouterSelect(params: {
  prompt: string;
  task_type?: string;
}): Promise<LlmRouterSelectionResponse> {
  return (await request("/llm/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  })) as LlmRouterSelectionResponse;
}
