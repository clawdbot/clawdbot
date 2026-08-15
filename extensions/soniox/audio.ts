/**
 * Soniox async speech-to-text helpers. Soniox transcription is job-based:
 * upload the file, create a transcription job, poll until it completes, then
 * fetch the transcript.
 */
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";
import { trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";

/** Default Soniox API base URL (US region). */
export const DEFAULT_SONIOX_API_BASE_URL = "https://api.soniox.com/v1";
/** Default Soniox async STT model. */
export const DEFAULT_SONIOX_STT_MODEL = "stt-async-v5";
/** Poll interval between transcription status checks. */
const SONIOX_POLL_INTERVAL_MS = 1_000;
/** Per-request timeout cap while polling (the overall deadline still applies). */
const SONIOX_REQUEST_TIMEOUT_MS = 30_000;

function resolveBaseUrl(baseUrl?: string): string {
  return (trimToUndefined(baseUrl) ?? DEFAULT_SONIOX_API_BASE_URL).replace(/\/+$/, "");
}

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  return trimmed || DEFAULT_SONIOX_STT_MODEL;
}

async function fetchJson(params: {
  url: string;
  init: RequestInit;
  apiKey: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  auditContext: string;
}): Promise<Record<string, unknown>> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: params.init,
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.url),
    auditContext: params.auditContext,
    ...(params.fetchFn ? { fetchImpl: params.fetchFn } : {}),
  });
  try {
    await assertOkOrThrowProviderError(response, "Soniox transcription API error");
    return await readProviderJsonResponse<Record<string, unknown>>(response, params.auditContext);
  } finally {
    await release();
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Soniox transcription aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Soniox transcription aborted"));
      },
      { once: true },
    );
  });
}

function readTranscriptionStatus(payload: Record<string, unknown>): string {
  const status = payload.status;
  if (typeof status !== "string") {
    throw new Error("Soniox transcription failed: malformed JSON response");
  }
  return status;
}

function readTranscriptionError(payload: Record<string, unknown>): string {
  const errorMessage = payload.error_message;
  return typeof errorMessage === "string" ? errorMessage : "unknown error";
}

function readTranscriptText(payload: Record<string, unknown>): string | undefined {
  if (payload.text !== undefined && typeof payload.text !== "string") {
    throw new Error("Soniox transcription failed: malformed JSON response");
  }
  return payload.text;
}

export async function transcribeSonioxAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const baseUrl = resolveBaseUrl(params.baseUrl);
  const model = resolveModel(params.model);
  const apiKey = params.auth?.kind === "api-key" ? params.auth.apiKey : params.apiKey;
  if (!apiKey) {
    throw new Error("Soniox API key missing");
  }
  const fetchFn = params.fetchFn ?? fetch;
  const deadline = Date.now() + params.timeoutMs;
  const requestTimeout = Math.min(params.timeoutMs, SONIOX_REQUEST_TIMEOUT_MS);

  // 1. Upload the audio file.
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(params.buffer)], {
      type: params.mime ?? "application/octet-stream",
    }),
    params.fileName,
  );
  const uploaded = await fetchJson({
    url: `${baseUrl}/files`,
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "OpenClaw" },
      body: form,
    },
    apiKey,
    timeoutMs: requestTimeout,
    signal: params.signal,
    fetchFn,
    auditContext: "soniox.transcription.upload",
  });
  const fileId = trimToUndefined(uploaded.id);
  if (!fileId) {
    throw new Error("Soniox transcription failed: missing file id");
  }

  // 2. Create the transcription job.
  const transcriptionBody: Record<string, unknown> = {
    model,
    file_id: fileId,
  };
  if (params.language?.trim()) {
    transcriptionBody.language_hints = [params.language.trim()];
  }
  if (params.enableSpeakerDiarization) {
    transcriptionBody.enable_speaker_diarization = true;
  }
  const created = await fetchJson({
    url: `${baseUrl}/transcriptions`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "OpenClaw",
      },
      body: JSON.stringify(transcriptionBody),
    },
    apiKey,
    timeoutMs: requestTimeout,
    signal: params.signal,
    fetchFn,
    auditContext: "soniox.transcription.create",
  });
  const transcriptionId = trimToUndefined(created.id);
  if (!transcriptionId) {
    throw new Error("Soniox transcription failed: missing transcription id");
  }

  // 3. Poll until the job completes (or the overall deadline expires).
  for (;;) {
    if (params.signal?.aborted) {
      throw new Error("Soniox transcription aborted");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("Soniox transcription timed out");
    }
    const job = await fetchJson({
      url: `${baseUrl}/transcriptions/${transcriptionId}`,
      init: {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "OpenClaw" },
      },
      apiKey,
      timeoutMs: Math.min(remaining, requestTimeout),
      signal: params.signal,
      fetchFn,
      auditContext: "soniox.transcription.status",
    });
    const status = readTranscriptionStatus(job);
    if (status === "completed") {
      break;
    }
    if (status === "failed" || status === "error") {
      throw new Error(`Soniox transcription failed: ${readTranscriptionError(job)}`);
    }
    await delay(Math.min(SONIOX_POLL_INTERVAL_MS, remaining), params.signal);
  }

  // 4. Fetch the transcript.
  const transcript = await fetchJson({
    url: `${baseUrl}/transcriptions/${transcriptionId}/transcript`,
    init: {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "OpenClaw" },
    },
    apiKey,
    timeoutMs: requestTimeout,
    signal: params.signal,
    fetchFn,
    auditContext: "soniox.transcription.transcript",
  });
  const text = requireTranscriptionText(
    readTranscriptText(transcript),
    "Soniox transcription response missing transcript",
  );
  return { text, model };
}
