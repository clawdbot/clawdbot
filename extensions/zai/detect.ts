// Zai plugin module implements detect behavior.
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_DEFAULT_MODEL_ID,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_DEFAULT_MODEL_ID,
  ZAI_GLOBAL_BASE_URL,
} from "./model-definitions.js";

export type ZaiEndpointId = "global" | "cn" | "coding-global" | "coding-cn";

export type ZaiDetectedEndpoint = {
  endpoint: ZaiEndpointId;
  /** Provider baseUrl to store in config. */
  baseUrl: string;
  /** Recommended default model id for that endpoint. */
  modelId: string;
  /** Human-readable note explaining the choice. */
  note: string;
};

type ProbeResult =
  | { ok: true }
  | {
      ok: false;
      status?: number;
      errorCode?: string;
      errorMessage?: string;
    };

type ProbeCandidate = ZaiDetectedEndpoint & {
  fallback?: boolean;
};

const UNSUPPORTED_MODEL_ERROR_CODES = new Set(["1211", "1311"]);

/** Cap for the Z.AI probe error body; bounds untrusted error responses to avoid unbounded buffering/OOM. */
const ZAI_DETECT_ERROR_BODY_MAX_BYTES = 16 * 1024 * 1024;

function isUnsupportedModelResult(result: ProbeResult): boolean {
  if (result.ok) {
    return false;
  }
  if (result.status === 404) {
    return true;
  }
  if (result.errorCode && UNSUPPORTED_MODEL_ERROR_CODES.has(result.errorCode)) {
    return true;
  }
  if (result.status !== 400) {
    return false;
  }
  const detail = `${result.errorCode ?? ""} ${result.errorMessage ?? ""}`.toLowerCase();
  return (
    /\bmodel\b.*\b(not found|unavailable|unsupported|does not exist)\b/.test(detail) ||
    /模型.*(不存在|不支持|不可用)/.test(detail)
  );
}

async function probeZaiChatCompletions(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}): Promise<ProbeResult> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: "Z.AI endpoint probe",
  });
  const resolveTimeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: params.timeoutMs,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  timeout.unref?.();
  let res: Response | undefined;
  try {
    const fetchFn = params.fetchFn ?? globalThis.fetch;
    res = await fetchFn(`${params.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: params.modelId,
        stream: false,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: controller.signal,
    });

    if (res.ok) {
      return { ok: true };
    }

    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    try {
      const bytes = await readResponseWithLimit(res, ZAI_DETECT_ERROR_BODY_MAX_BYTES, {
        // Resolve immediately before body consumption so headers and every
        // body shape share one operation budget, including slow-drip streams.
        timeoutMs: resolveTimeoutMs,
        onTimeout: ({ timeoutMs }) =>
          new Error(`Z.AI probe error body timed out after ${timeoutMs}ms`),
        onOverflow: ({ maxBytes }) =>
          new Error(`Z.AI probe error body exceeded size limit (${maxBytes} bytes)`),
      });
      const json = JSON.parse(new TextDecoder().decode(bytes)) as {
        error?: { code?: unknown; message?: unknown };
        code?: unknown;
        msg?: unknown;
        message?: unknown;
      };
      const code = json?.error?.code ?? json?.code;
      const msg = json?.error?.message ?? json?.msg ?? json?.message;
      if (typeof code === "string") {
        errorCode = code;
      } else if (typeof code === "number") {
        errorCode = String(code);
      }
      if (typeof msg === "string") {
        errorMessage = msg;
      }
    } catch {
      // ignore malformed / stalled / oversized error bodies
    }

    return { ok: false, status: res.status, errorCode, errorMessage };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
    if (res?.bodyUsed !== true) {
      await res?.body?.cancel().catch(() => undefined);
    }
  }
}

export async function detectZaiEndpoint(params: {
  apiKey: string;
  endpoint?: ZaiEndpointId;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<ZaiDetectedEndpoint | null> {
  // Never auto-probe in vitest; it would create flaky network behavior.
  if (process.env.VITEST && !params.fetchFn) {
    return null;
  }

  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 5_000);
  const probeCandidates = (() => {
    const general: ProbeCandidate[] = [
      {
        endpoint: "global" as const,
        baseUrl: ZAI_GLOBAL_BASE_URL,
        modelId: ZAI_DEFAULT_MODEL_ID,
        note: "Verified GLM-5.1 on global endpoint.",
      },
      {
        endpoint: "cn" as const,
        baseUrl: ZAI_CN_BASE_URL,
        modelId: ZAI_DEFAULT_MODEL_ID,
        note: "Verified GLM-5.1 on cn endpoint.",
      },
    ];
    const codingModels: ProbeCandidate[] = [
      {
        endpoint: "coding-global" as const,
        baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
        modelId: ZAI_CODING_DEFAULT_MODEL_ID,
        note: "Verified GLM-5.2 on coding-global endpoint.",
      },
      {
        endpoint: "coding-global" as const,
        baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
        modelId: "glm-5.1",
        note: "Verified GLM-5.1 on coding-global endpoint; GLM-5.2 is unavailable.",
        fallback: true,
      },
      {
        endpoint: "coding-cn" as const,
        baseUrl: ZAI_CODING_CN_BASE_URL,
        modelId: ZAI_CODING_DEFAULT_MODEL_ID,
        note: "Verified GLM-5.2 on coding-cn endpoint.",
      },
      {
        endpoint: "coding-cn" as const,
        baseUrl: ZAI_CODING_CN_BASE_URL,
        modelId: "glm-5.1",
        note: "Verified GLM-5.1 on coding-cn endpoint; GLM-5.2 is unavailable.",
        fallback: true,
      },
    ];
    const codingFallback: ProbeCandidate[] = [
      {
        endpoint: "coding-global" as const,
        baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
        modelId: "glm-4.7",
        note: "Coding Plan endpoint verified, but this key/plan does not expose GLM-5.2 or GLM-5.1 there. Defaulting to GLM-4.7.",
        fallback: true,
      },
      {
        endpoint: "coding-cn" as const,
        baseUrl: ZAI_CODING_CN_BASE_URL,
        modelId: "glm-4.7",
        note: "Coding Plan CN endpoint verified, but this key/plan does not expose GLM-5.2 or GLM-5.1 there. Defaulting to GLM-4.7.",
        fallback: true,
      },
    ];

    switch (params.endpoint) {
      case "global":
        return general.filter((candidate) => candidate.endpoint === "global");
      case "cn":
        return general.filter((candidate) => candidate.endpoint === "cn");
      case "coding-global":
        return [
          ...codingModels.filter((candidate) => candidate.endpoint === "coding-global"),
          ...codingFallback.filter((candidate) => candidate.endpoint === "coding-global"),
        ];
      case "coding-cn":
        return [
          ...codingModels.filter((candidate) => candidate.endpoint === "coding-cn"),
          ...codingFallback.filter((candidate) => candidate.endpoint === "coding-cn"),
        ];
      default:
        return [...general, ...codingModels, ...codingFallback];
    }
  })();

  const resultsByEndpoint = new Map<ZaiEndpointId, ProbeResult[]>();
  for (const candidate of probeCandidates) {
    const priorResults = resultsByEndpoint.get(candidate.endpoint) ?? [];
    if (
      candidate.fallback &&
      (priorResults.length === 0 || !priorResults.every(isUnsupportedModelResult))
    ) {
      continue;
    }
    const result = await probeZaiChatCompletions({
      baseUrl: candidate.baseUrl,
      apiKey: params.apiKey,
      modelId: candidate.modelId,
      timeoutMs,
      fetchFn: params.fetchFn,
    });
    if (result.ok) {
      return {
        endpoint: candidate.endpoint,
        baseUrl: candidate.baseUrl,
        modelId: candidate.modelId,
        note: candidate.note,
      };
    }
    resultsByEndpoint.set(candidate.endpoint, [...priorResults, result]);
  }

  return null;
}
