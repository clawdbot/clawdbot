import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promptAndConfigureOllama } from "./setup.js";

function createOllamaSetupPrompter(mode: "local-only" | "cloud-only"): WizardPrompter {
  return {
    select: vi.fn().mockResolvedValueOnce(mode),
    text: vi
      .fn()
      .mockResolvedValueOnce(mode === "cloud-only" ? "test-ollama-key" : "http://127.0.0.1:11434"),
    note: vi.fn(async () => undefined),
  } as unknown as WizardPrompter;
}

function abortReasonAsError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Request aborted", { cause: signal.reason });
}

describe("Ollama setup cancellation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["local-only", "cloud-only"] as const)(
    "aborts pending %s model discovery with the setup session",
    async (mode) => {
      const controller = new AbortController();
      let markTagsStarted!: () => void;
      let rejectPendingFetch!: (reason: Error) => void;
      let requestSignal: AbortSignal | undefined;
      const tagsStarted = new Promise<void>((resolve) => {
        markTagsStarted = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (!requestUrl(input).endsWith("/api/tags")) {
            throw new Error(`Unexpected fetch: ${requestUrl(input)}`);
          }
          markTagsStarted();
          return await new Promise<Response>((_resolve, reject) => {
            rejectPendingFetch = reject;
            const signal = init?.signal;
            requestSignal = signal ?? undefined;
            if (!signal) {
              reject(new Error("expected model discovery abort signal"));
              return;
            }
            signal.addEventListener("abort", () => reject(abortReasonAsError(signal)), {
              once: true,
            });
          });
        }),
      );

      const setup = promptAndConfigureOllama({
        cfg: {},
        env: {},
        prompter: createOllamaSetupPrompter(mode),
        allowSecretRefPrompt: false,
        signal: controller.signal,
      });
      await tagsStarted;
      controller.abort();

      try {
        expect(requestSignal?.aborted).toBe(true);
        await expect(setup).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        rejectPendingFetch(new Error("Ollama test completed"));
        await setup.catch(() => undefined);
      }
    },
  );
});
