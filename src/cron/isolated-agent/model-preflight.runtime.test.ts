// Runtime model preflight tests cover provider/model checks before cron execution.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  preflightCronModelProvider,
  resetCronModelProviderPreflightCacheForTest,
} from "./model-preflight.runtime.js";

function mockReachableResponse(status = 200) {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: { status },
    release: vi.fn(async () => {}),
  });
}

function requireFetchPreflightRequest(): {
  url?: string;
  timeoutMs?: number;
  auditContext?: string;
} {
  const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as
    | { url?: string; timeoutMs?: number; auditContext?: string }
    | undefined;
  if (!request) {
    throw new Error("Expected cron model preflight fetch request");
  }
  return request;
}

describe("preflightCronModelProvider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    resetCronModelProviderPreflightCacheForTest();
  });

  it("skips network checks for cloud provider URLs", async () => {
    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(result).toEqual({ status: "available" });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("treats any HTTP response from a local OpenAI-compatible endpoint as reachable", async () => {
    mockReachableResponse(401);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            vllm: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
              models: [],
            },
          },
        },
      },
      provider: "vllm",
      model: "llama",
    });

    expect(result).toEqual({ status: "available" });
    const request = requireFetchPreflightRequest();
    expect(request.url).toBe("http://127.0.0.1:8000/v1/models");
    expect(request.timeoutMs).toBe(2500);
  });

  it("marks unreachable local Ollama endpoints unavailable and caches the result", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const cfg = {
      models: {
        providers: {
          Ollama: {
            api: "ollama" as const,
            baseUrl: "http://localhost:11434",
            models: [],
          },
        },
      },
    };
    const first = await preflightCronModelProvider({
      cfg,
      provider: "ollama",
      model: "qwen3:32b",
      nowMs: 1000,
    });
    const second = await preflightCronModelProvider({
      cfg,
      provider: "ollama",
      model: "llama3.3:70b",
      nowMs: 2000,
    });

    expect(first.status).toBe("unavailable");
    if (first.status !== "unavailable") {
      throw new Error(`expected first preflight unavailable, got ${first.status}`);
    }
    expect(first.provider).toBe("ollama");
    expect(first.model).toBe("qwen3:32b");
    expect(first.baseUrl).toBe("http://localhost:11434");
    expect(first.retryAfterMs).toBe(300000);
    expect(first.reason).toContain("the local provider preflight failed");
    expect(first.reason).not.toContain("endpoint is not reachable");
    expect(first.reason).toContain("Last error: Error: ECONNREFUSED");
    expect(first.reason).not.toContain("timed out after");
    expect(second.status).toBe("unavailable");
    if (second.status !== "unavailable") {
      throw new Error(`expected second preflight unavailable, got ${second.status}`);
    }
    expect(second.provider).toBe("ollama");
    expect(second.model).toBe("llama3.3:70b");
    expect(second.baseUrl).toBe("http://localhost:11434");
    expect(second.retryAfterMs).toBe(300000);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    const request = requireFetchPreflightRequest();
    expect(request.url).toBe("http://localhost:11434/api/tags");
    expect(request.auditContext).toBe("cron-model-provider-preflight");
  });

  it("reports a nested guarded-fetch deadline separately from endpoint failures", async () => {
    const timeoutError = new Error("request timed out");
    timeoutError.name = "TimeoutError";
    fetchWithSsrFGuardMock.mockRejectedValueOnce(
      new TypeError("fetch failed", { cause: timeoutError }),
    );

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://localhost:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "qwen3:32b",
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error(`expected preflight unavailable, got ${result.status}`);
    }
    expect(result.reason).toContain(
      "Last error: Local provider preflight exceeded its configured 2500ms deadline | " +
        "TypeError: fetch failed | TimeoutError: request timed out",
    );
    expect(result.reason).not.toContain("ECONNREFUSED");
  });

  it("preserves nested abort details without classifying a generic abort as timeout", async () => {
    const connectionError = Object.assign(new Error("connect ECONNREFUSED"), {
      name: "ConnectError",
      code: "ECONNREFUSED",
    });
    const abortError = Object.assign(new Error("request aborted", { cause: connectionError }), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
    fetchWithSsrFGuardMock.mockRejectedValueOnce(abortError);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://localhost:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "qwen3:32b",
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error(`expected preflight unavailable, got ${result.status}`);
    }
    expect(result.reason).toContain(
      "Last error: AbortError: request aborted (code=ABORT_ERR) | " +
        "ConnectError: connect ECONNREFUSED (code=ECONNREFUSED)",
    );
    expect(result.reason).not.toContain("timed out after");
    expect(result.reason).not.toContain("endpoint is not reachable");
  });

  it("bounds cyclic cause-chain inspection", async () => {
    const errors = Array.from({ length: 12 }, (_, index) =>
      Object.assign(new Error(`failure-${index}`), {
        name: `NestedError${index}`,
        code: `ELOOP${index}`,
        cause: undefined as unknown,
      }),
    );
    for (let index = 0; index < errors.length - 1; index += 1) {
      errors[index]!.cause = errors[index + 1];
    }
    errors.at(-1)!.cause = errors[0];
    fetchWithSsrFGuardMock.mockRejectedValueOnce(errors[0]);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://localhost:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "qwen3:32b",
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error(`expected preflight unavailable, got ${result.status}`);
    }
    expect(result.reason.match(/failure-0/g)).toHaveLength(1);
    expect(result.reason).toContain("NestedError7: failure-7 (code=ELOOP7)");
    expect(result.reason).not.toContain("failure-8");
  });

  it("bounds long diagnostics without splitting UTF-16 surrogate pairs", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error(`${"x".repeat(992)}😀truncated-detail`));

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://localhost:11434",
              models: [],
            },
          },
        },
      },
      provider: "ollama",
      model: "qwen3:32b",
    });

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") {
      throw new Error(`expected preflight unavailable, got ${result.status}`);
    }
    const diagnostic = result.reason.split("Last error: ")[1];
    expect(diagnostic).toHaveLength(1_000);
    expect(diagnostic).toMatch(/^Error: x+…$/u);
    expect(diagnostic).not.toContain("😀");
    expect(diagnostic).not.toContain("truncated-detail");
    expect(/[\uD800-\uDBFF]$/u.test(diagnostic ?? "")).toBe(false);
  });

  it("retries an unavailable endpoint after the cache ttl", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce({
      response: { status: 200 },
      release: vi.fn(async () => {}),
    });

    const cfg = {
      models: {
        providers: {
          ollama: {
            api: "ollama" as const,
            baseUrl: "http://127.0.0.1:11434",
            models: [],
          },
        },
      },
    };

    const first = await preflightCronModelProvider({
      cfg,
      provider: "ollama",
      model: "llama3",
      nowMs: 1000,
    });
    const second = await preflightCronModelProvider({
      cfg,
      provider: "ollama",
      model: "llama3",
      nowMs: 1000 + 300001,
    });

    expect(first.status).toBe("unavailable");
    expect(second).toEqual({ status: "available" });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
  });
});
