import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/label-open-issues.ts";

const labelItem = {
  number: 123,
  title: "Crash when loading channel",
  body: "The app crashes on startup.",
  labels: [],
};

describe("label-open-issues helpers", () => {
  it("classifies items from OpenAI structured response text", async () => {
    const response = {
      ok: true,
      status: 200,
      json: async () => ({
        output_text: JSON.stringify({
          category: "bug",
          isSupport: true,
          isSkillOnly: false,
        }),
      }),
    } as Response;

    await expect(
      testing.classifyItem(labelItem, "issue", {
        apiKey: "test-key",
        model: "test-model",
        timeoutMs: 50,
        fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
      }),
    ).resolves.toEqual({
      category: "bug",
      isSupport: true,
      isSkillOnly: false,
    });
  });

  it("aborts stalled OpenAI classification fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    const request = testing.classifyItem(labelItem, "issue", {
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
    });

    await expect(request).rejects.toThrow(
      /OpenAI issue label classification request exceeded timeout/u,
    );
    expect(signal?.aborted).toBe(true);
  });

  it("times out stalled OpenAI classification body reads", async () => {
    const response = {
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    } as Response;
    const request = testing.classifyItem(labelItem, "issue", {
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 5,
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });

    await expect(request).rejects.toThrow(
      /OpenAI issue label classification request exceeded timeout/u,
    );
  });

  it("bounds OpenAI error response bodies", async () => {
    const tail = "tail-sentinel-should-not-appear";
    const response = new Response(`${"x".repeat(5000)}${tail}`, {
      status: 500,
    });
    let message = "";

    try {
      await testing.classifyItem(labelItem, "issue", {
        apiKey: "test-key",
        model: "test-model",
        timeoutMs: 50,
        fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("OpenAI request failed (500):");
    expect(message).toContain("[truncated]");
    expect(message).not.toContain(tail);
    expect(message.length).toBeLessThan(4300);
  });

  it("rejects invalid OpenAI classification timeout values", () => {
    expect(testing.resolveOpenAITimeoutMs("250")).toBe(250);
    expect(() => testing.resolveOpenAITimeoutMs("slow")).toThrow(
      /OPENCLAW_LABEL_OPEN_ISSUES_OPENAI_TIMEOUT_MS must be an integer/u,
    );
  });
});
