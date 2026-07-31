// Runtime model preflight tests cover provider/model checks before cron execution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";

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

  it.each(["https://api.openai.com/v1", "http://128.0.0.1:8000/v1"])(
    "skips network checks for non-local provider URL %s",
    async (baseUrl) => {
      const result = await preflightCronModelProvider({
        cfg: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl,
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
    },
  );

  it.each([
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.222",
    "[::1]",
    "[::ffff:7f00:1]",
    "[::ffff:127.0.0.1]",
  ])("treats any HTTP response from local endpoint host %s as reachable", async (host) => {
    mockReachableResponse(401);

    const result = await preflightCronModelProvider({
      cfg: {
        models: {
          providers: {
            vllm: {
              api: "openai-completions",
              baseUrl: `http://${host}:8000/v1`,
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
    expect(request.url).toBe(`http://${host}:8000/v1/models`);
    expect(request.timeoutMs).toBe(2500);
  });

  it("starts unread-body cancellation before release without waiting for a split stream", async () => {
    const cleanupOrder: string[] = [];
    const cancel = vi.fn(() => {
      cleanupOrder.push("cancel");
      return new Promise<void>(() => {});
    });
    const release = vi.fn(async () => {
      cleanupOrder.push("release");
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: { status: 200, bodyUsed: false, body: { cancel } },
      release,
    });
    const cfg = {
      models: {
        providers: {
          vllm: {
            api: "openai-completions" as const,
            baseUrl: "http://127.0.0.1:8000/v1",
            models: [],
          },
        },
      },
    };

    const result = await withTestTimeout(
      preflightCronModelProvider({ cfg, provider: "vllm", model: "llama" }),
      1_000,
      "cron provider preflight waited for unread response-body cancellation",
    );
    const cached = await preflightCronModelProvider({
      cfg,
      provider: "vllm",
      model: "llama-cached",
    });

    expect(result).toEqual({ status: "available" });
    expect(cached).toEqual({ status: "available" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    expect(cleanupOrder).toEqual(["cancel", "release"]);
  });

  it("keeps a reachable provider available when response cancellation rejects", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("provider response was already closed");
    });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: { status: 401, bodyUsed: false, body: { cancel } },
      release,
    });

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
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not cancel a response body that has already been consumed", async () => {
    const cancel = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: { status: 200, bodyUsed: true, body: { cancel } },
      release,
    });

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
    expect(cancel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("cancels and releases every response during concurrent local-provider probes", async () => {
    const cancel = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockImplementation(async () => ({
      response: { status: 200, bodyUsed: false, body: { cancel } },
      release,
    }));

    const results = await withTestTimeout(
      Promise.all(
        Array.from({ length: 32 }, (_, index) =>
          preflightCronModelProvider({
            cfg: {
              models: {
                providers: {
                  vllm: {
                    api: "openai-completions",
                    baseUrl: `http://127.0.0.1:${18_000 + index}/v1`,
                    models: [],
                  },
                },
              },
            },
            provider: "vllm",
            model: `model-${index}`,
          }),
        ),
      ),
      1_000,
      "concurrent cron provider preflights did not release their response bodies",
    );

    expect(results).toEqual(Array.from({ length: 32 }, () => ({ status: "available" })));
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(32);
    expect(cancel).toHaveBeenCalledTimes(32);
    expect(release).toHaveBeenCalledTimes(32);
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
