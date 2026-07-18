// Label Open Issues tests cover label open issues script behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "../../scripts/label-open-issues.ts";

const labelItem = {
  number: 123,
  title: "Crash when loading channel",
  body: "The app crashes on startup.",
  labels: [],
};

describe("label-open-issues helpers", () => {
  // Timeout tests below advance fake timers explicitly so CI shard load cannot
  // turn a bounded request-timeout assertion into a wall-clock wait.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses CLI options strictly before external calls", () => {
    expect(testing.parseArgs(["--dry-run", "--limit", "2", "--model", "gpt-5.5"])).toEqual({
      dryRun: true,
      limit: 2,
      model: "gpt-5.5",
    });

    expect(() => testing.parseArgs(["--model", "--dry-run"])).toThrow("Missing --model value");
    expect(() => testing.parseArgs(["--model", "-h"])).toThrow("Missing --model value");
    expect(() => testing.parseArgs(["--limit", "--dry-run"])).toThrow(
      "Missing/invalid --limit value",
    );
    expect(() => testing.parseArgs(["--limit", "-h"])).toThrow("Missing/invalid --limit value");
    expect(() => testing.parseArgs(["--wat"])).toThrow("Unknown argument: --wat");
  });

  it("classifies items from OpenAI structured response text", async () => {
    const response = new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          category: "bug",
          isSupport: true,
          isSkillOnly: false,
        }),
      }),
      { status: 200 },
    );

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
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });

    vi.useFakeTimers();
    const request = testing.classifyItem(labelItem, "issue", {
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        markFetchStarted();
        return new Promise(() => {});
      }) as typeof fetch,
    });
    const rejection = expect(request).rejects.toThrow(
      /OpenAI issue label classification request exceeded timeout/u,
    );

    await fetchStarted;
    await vi.advanceTimersByTimeAsync(5);

    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("times out stalled OpenAI classification body reads", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200 },
    );
    vi.useFakeTimers();
    const request = testing.classifyItem(labelItem, "issue", {
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 5,
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });
    const rejection = expect(request).rejects.toThrow(
      /OpenAI issue label classification request exceeded timeout/u,
    );

    await vi.advanceTimersByTimeAsync(5);

    await rejection;
    await Promise.resolve();
    expect(canceled).toBe(true);
  });

  it("cancels stalled OpenAI classification error body reads", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 500 },
    );
    vi.useFakeTimers();
    const request = testing.classifyItem(labelItem, "issue", {
      apiKey: "test-key",
      model: "test-model",
      timeoutMs: 5,
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });
    const rejection = expect(request).rejects.toThrow(
      /OpenAI issue label classification request exceeded timeout/u,
    );

    await vi.advanceTimersByTimeAsync(5);

    await rejection;
    await Promise.resolve();
    expect(canceled).toBe(true);
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

  it("reads bounded OpenAI classification JSON responses", async () => {
    await expect(
      testing.readBoundedOpenAIJson(new Response('{"output_text":"{}"}'), 1024),
    ).resolves.toEqual({ output_text: "{}" });
  });

  it("rejects oversized OpenAI classification JSON responses by content length", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      {
        headers: {
          "content-length": "1025",
        },
      },
    );

    await expect(testing.readBoundedOpenAIJson(response, 1024)).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "OpenAI classification response body exceeded 1024 bytes",
    });
    expect(canceled).toBe(true);
  });

  it("rejects oversized streamed OpenAI classification JSON responses", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"output_text":"'));
          controller.enqueue(encoder.encode("x".repeat(1024)));
          controller.enqueue(encoder.encode('"}'));
          controller.close();
        },
      }),
    );

    await expect(testing.readBoundedOpenAIJson(response, 1024)).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "OpenAI classification response body exceeded 1024 bytes",
    });
  });

  it("rejects invalid OpenAI classification timeout values", () => {
    expect(testing.resolveOpenAITimeoutMs("250")).toBe(250);
    expect(() => testing.resolveOpenAITimeoutMs("slow")).toThrow(
      /OPENCLAW_LABEL_OPEN_ISSUES_OPENAI_TIMEOUT_MS must be an integer/u,
    );
  });

  it("does not split boundary emoji in model prompts", async () => {
    let requestBody = "";
    const response = new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          category: "bug",
          isSupport: false,
          isSkillOnly: false,
        }),
      }),
      { status: 200 },
    );

    await testing.classifyItem(
      {
        ...labelItem,
        body: `${"a".repeat(5999)}😀tail`,
      },
      "issue",
      {
        apiKey: "placeholder",
        model: "test-model",
        timeoutMs: 50,
        fetchImpl: ((_url, init) => {
          requestBody = String(init?.body ?? "");
          return Promise.resolve(response);
        }) as typeof fetch,
      },
    );

    const payload = JSON.parse(requestBody) as { input: Array<{ content: string }> };
    const prompt = payload.input[1]?.content ?? "";
    expect(prompt).toContain(`${"a".repeat(5999)}\n\n[truncated]`);
    expect(prompt).not.toContain("\uD83D");
    expect(prompt).not.toContain("tail");
  });
});
