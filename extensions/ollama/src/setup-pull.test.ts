import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pullOllamaModel, pullOllamaModelNonInteractive } from "./setup-pull.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

describe("Ollama onboarding model pulls", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("uses the canonical Ollama model request field and requires its success terminal", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('{"status":"pulling manifest"}\n{"status":"success"}\n'),
      release,
    });
    const progress = { update: vi.fn(), stop: vi.fn() };
    const prompter = { progress: vi.fn(() => progress) } as unknown as WizardPrompter;

    await expect(pullOllamaModel("http://127.0.0.1:11434", "gemma4:e2b", prompter)).resolves.toBe(
      true,
    );

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as { init?: { body?: string } };
    expect(JSON.parse(request.init?.body ?? "null")).toEqual({ model: "gemma4:e2b" });
    expect(progress.stop).toHaveBeenCalledWith("Downloaded gemma4:e2b");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "empty response", body: "" },
    { label: "interrupted manifest download", body: '{"status":"pulling manifest"}\n' },
    {
      label: "interrupted model layer",
      body: '{"status":"pulling abcdef123456","total":100,"completed":40}\n',
    },
    { label: "malformed stream", body: "not valid json\n" },
    { label: "incomplete trailing record", body: '{"status":"success"' },
  ])("does not report a completed model pull for an $label", async ({ body }) => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({ response: new Response(body), release });
    const progress = { update: vi.fn(), stop: vi.fn() };
    const prompter = { progress: vi.fn(() => progress) } as unknown as WizardPrompter;

    await expect(pullOllamaModel("http://127.0.0.1:11434", "gemma4:e2b", prompter)).resolves.toBe(
      false,
    );

    expect(progress.stop).toHaveBeenCalledWith(
      "Failed to download gemma4:e2b: pull stream ended before success",
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("accepts a final success record without a trailing newline", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('{"status":"success"}'),
      release: vi.fn(async () => {}),
    });
    const progress = { update: vi.fn(), stop: vi.fn() };
    const prompter = { progress: vi.fn(() => progress) } as unknown as WizardPrompter;

    await expect(pullOllamaModel("http://127.0.0.1:11434", "gemma4:e2b", prompter)).resolves.toBe(
      true,
    );
    expect(progress.stop).toHaveBeenCalledWith("Downloaded gemma4:e2b");
  });

  it("reports interrupted pulls as failures during non-interactive setup", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response('{"status":"pulling manifest"}\n'),
      release: vi.fn(async () => {}),
    });
    const runtime = { log: vi.fn(), error: vi.fn() };

    await expect(
      pullOllamaModelNonInteractive("http://127.0.0.1:11434", "gemma4:e2b", runtime as never),
    ).resolves.toBe(false);

    expect(runtime.error).toHaveBeenCalledWith(
      "Failed to download gemma4:e2b: pull stream ended before success",
    );
    expect(runtime.log).not.toHaveBeenCalledWith("Downloaded gemma4:e2b");
  });

  it("coerces non-Error stream failures through the shared error contract", async () => {
    const release = vi.fn(async () => {});
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error({ code: "OLLAMA_PULL_INTERRUPTED" });
        },
      }),
    );
    fetchWithSsrFGuardMock.mockResolvedValue({ response, release });
    const progress = { update: vi.fn(), stop: vi.fn() };
    const prompter = {
      progress: vi.fn(() => progress),
    } as unknown as WizardPrompter;

    await expect(pullOllamaModel("http://127.0.0.1:11434", "gemma4:e2b", prompter)).resolves.toBe(
      false,
    );

    expect(progress.stop).toHaveBeenCalledWith(
      expect.stringContaining("Failed to download gemma4:e2b: Non-Error rejection"),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("cancels an oversized unterminated pull record", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let readCount = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        readCount += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(body, { status: 200 }),
      release,
    });
    const progress = { update: vi.fn(), stop: vi.fn() };
    const prompter = {
      progress: vi.fn(() => progress),
    } as unknown as WizardPrompter;

    await expect(pullOllamaModel("http://127.0.0.1:11434", "gemma4:e2b", prompter)).resolves.toBe(
      false,
    );

    expect(readCount).toBeGreaterThan(16);
    expect(readCount).toBeLessThan(32);
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
    expect(progress.stop).toHaveBeenCalledWith(
      "Failed to download gemma4:e2b: Ollama NDJSON record exceeds 16777216 bytes",
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
