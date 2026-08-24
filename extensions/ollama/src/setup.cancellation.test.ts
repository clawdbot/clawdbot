import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promptAndConfigureOllama } from "./setup.js";

function createLocalPrompter(): WizardPrompter {
  return {
    select: vi.fn().mockResolvedValueOnce("local-only"),
    text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
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

  it("aborts pending model discovery with the setup session", async () => {
    const controller = new AbortController();
    let markTagsStarted!: () => void;
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
          const signal = init?.signal;
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
      prompter: createLocalPrompter(),
      signal: controller.signal,
    });
    await tagsStarted;
    controller.abort();

    await expect(setup).rejects.toMatchObject({ name: "AbortError" });
  });
});
