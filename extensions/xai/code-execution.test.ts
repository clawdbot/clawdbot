// Xai tests cover code execution plugin behavior.
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeExecutionTool } from "./code-execution.js";

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function malformedJsonResponse(): Response {
  return new Response("{ nope", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installCodeExecutionFetch(payload?: Record<string, unknown>) {
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve(
      jsonResponse(
        payload ?? {
          output: [
            { type: "code_interpreter_call" },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Mean: 42",
                  annotations: [{ type: "url_citation", url: "https://example.com/data.csv" }],
                },
              ],
            },
          ],
          citations: ["https://example.com/data.csv"],
        },
      ),
    ),
  );
  global.fetch = withFetchPreconnect(mockFetch);
  return mockFetch;
}

function firstFetchCall(mockFetch: ReturnType<typeof installCodeExecutionFetch>) {
  const [call] = mockFetch.mock.calls;
  if (!call) {
    throw new Error("expected code_execution fetch call");
  }
  return call;
}

function firstFetchUrl(mockFetch: ReturnType<typeof installCodeExecutionFetch>) {
  const [url] = firstFetchCall(mockFetch);
  return String(url);
}

function firstFetchInit(mockFetch: ReturnType<typeof installCodeExecutionFetch>): RequestInit {
  const [, init] = firstFetchCall(mockFetch);
  if (!init || typeof init !== "object" || Array.isArray(init)) {
    throw new Error("expected code_execution fetch init");
  }
  return init as RequestInit;
}

function firstAuthorizationHeader(mockFetch: ReturnType<typeof installCodeExecutionFetch>) {
  return new Headers(firstFetchInit(mockFetch).headers).get("Authorization");
}

function parseFirstRequestBody(mockFetch: ReturnType<typeof installCodeExecutionFetch>) {
  const requestBody = firstFetchInit(mockFetch).body;
  return JSON.parse(typeof requestBody === "string" ? requestBody : "{}") as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("xai code_execution tool", () => {
  it("enables code_execution when the xAI plugin web search key is configured", () => {
    const tool = createCodeExecutionTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    expect(tool?.name).toBe("code_execution");
  });

  it("enables code_execution from an xAI auth profile and uses it for requests", async () => {
    const mockFetch = installCodeExecutionFetch();
    const tool = createCodeExecutionTool({
      config: {},
      auth: {
        hasAuthForProvider: (providerId) => providerId === "xai",
        resolveApiKeyForProvider: async (providerId) =>
          providerId === "xai" ? "xai-profile-key" : undefined, // pragma: allowlist secret
      },
    });

    expect(tool?.name).toBe("code_execution");
    await tool?.execute?.("code-execution:auth-profile", {
      task: "Sum [20, 22]",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer xai-profile-key");
  });

  it("uses the xAI Responses code_interpreter tool", async () => {
    const mockFetch = installCodeExecutionFetch();
    const tool = createCodeExecutionTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-config-test", // pragma: allowlist secret
                },
                codeExecution: {
                  maxTurns: 2,
                  timeoutSeconds: 45,
                },
              },
            },
          },
        },
      },
    });

    const result = await tool?.execute?.("code-execution:1", {
      task: "Calculate the mean of [40, 42, 44]",
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(firstFetchUrl(mockFetch)).toContain("api.x.ai/v1/responses");
    const body = parseFirstRequestBody(mockFetch);
    expect(body.model).toBe("grok-4.6");
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.max_turns).toBe(2);
    expect(body.tools).toEqual([{ type: "code_interpreter" }]);
    expect(
      (result?.details as { usedCodeExecution?: boolean } | undefined)?.usedCodeExecution,
    ).toBe(true);
  });

  it("returns every response answer and citation from the code execution HTTP boundary", async () => {
    const mockFetch = installCodeExecutionFetch({
      output: [
        { type: "code_interpreter_call" },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "Mean: ",
              annotations: [{ type: "url_citation", url: "https://example.com/input.csv" }],
            },
            {
              type: "output_text",
              text: "42",
              annotations: [
                { type: "url_citation", url: "https://example.com/result.csv" },
                { type: "url_citation", url: "https://example.com/input.csv" },
              ],
            },
          ],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: ". Verified." }],
        },
      ],
    });
    const tool = createCodeExecutionTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: { apiKey: "xai-plugin-key" }, // pragma: allowlist secret
              },
            },
          },
        },
      },
    });

    const result = await tool?.execute?.("code-execution:multi-block", {
      task: "Calculate and verify the mean.",
    });

    expect(firstFetchUrl(mockFetch)).toContain("api.x.ai/v1/responses");
    expect(result?.details).toMatchObject({
      content: "Mean: 42. Verified.",
      citations: ["https://example.com/input.csv", "https://example.com/result.csv"],
      usedCodeExecution: true,
    });
  });

  it("reuses the xAI plugin web search key without overriding custom model reasoning", async () => {
    const mockFetch = installCodeExecutionFetch();
    const tool = createCodeExecutionTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
                codeExecution: { model: "grok-build-0.1" },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("code-execution:plugin-key", {
      task: "Compute the standard deviation of [1, 2, 3]",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer xai-plugin-key");
    const body = parseFirstRequestBody(mockFetch);
    expect(body.model).toBe("grok-build-0.1");
    expect(body.input).toEqual([
      { role: "user", content: "Compute the standard deviation of [1, 2, 3]" },
    ]);
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("max_turns");
  });

  it("reports malformed code_execution JSON as a provider error", async () => {
    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve(malformedJsonResponse()),
    );
    global.fetch = withFetchPreconnect(mockFetch);
    const tool = createCodeExecutionTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await expect(
      tool?.execute?.("code-execution:malformed-json", {
        task: "Calculate the mean of [40, 42, 44]",
      }),
    ).rejects.toThrow("xAI code execution failed: malformed JSON response");
  });

  it("reports missing code_execution answers without blaming JSON decoding", async () => {
    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve(
        jsonResponse({ status: "incomplete", output: [{ type: "code_interpreter_call" }] }),
      ),
    );
    global.fetch = withFetchPreconnect(mockFetch);
    const tool = createCodeExecutionTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await expect(
      tool?.execute?.("code-execution:missing-text", {
        task: "Calculate the mean of [40, 42, 44]",
      }),
    ).rejects.toThrow("xAI code execution failed: no answer text returned; try a simpler request");
  });
});
