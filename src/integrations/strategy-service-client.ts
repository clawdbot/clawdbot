export type PdfSummaryResult = {
  doc_id: string;
  model: string;
  engine: string;
  summary: string;
  used_cached_annotations?: boolean;
  annotations_cached?: boolean;
};

const DEFAULT_STRATEGY_SERVICE_URL = "http://127.0.0.1:8011";

function resolveBaseUrl(): string {
  return (process.env.STRATEGY_SERVICE_URL ?? DEFAULT_STRATEGY_SERVICE_URL).trim().replace(/\/$/, "");
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  return JSON.parse(text) as unknown;
}

export async function summarizePdfViaStrategyService(params: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  prompt?: string;
}): Promise<PdfSummaryResult> {
  const form = new FormData();
  const blob = new Blob([params.bytes], { type: params.mimeType });
  form.append("file", blob, params.filename);
  form.append("prompt", params.prompt ?? "Summarize this PDF for the agent, keeping important facts and user-relevant details.");

  const response = await fetch(`${resolveBaseUrl()}/pdf/summarize`, {
    method: "POST",
    body: form,
  });
  const payload = await parseJson(response);
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "detail" in payload
        ? String((payload as { detail?: unknown }).detail)
        : `strategy-service request failed (${response.status})`;
    throw new Error(detail);
  }
  return payload as PdfSummaryResult;
}
