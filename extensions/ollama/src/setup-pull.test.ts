import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pullOllamaModel } from "./setup-pull.js";

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
});
