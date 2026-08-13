import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";

describe("createVpsAwareOAuthHandlers", () => {
  it("sends remote OAuth URLs through the wizard prompter", async () => {
    const note = vi.fn(async () => undefined);
    const text = vi.fn(async () => "callback-value");
    const openUrl = vi.fn(async () => undefined);
    const spin = { update: vi.fn(), stop: vi.fn() };
    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter: { note, text } as unknown as WizardPrompter,
      runtime: { log: vi.fn() } as unknown as RuntimeEnv,
      spin: spin as ReturnType<WizardPrompter["progress"]>,
      openUrl,
      localBrowserMessage: "Opening browser",
    });

    await handlers.onAuth({ url: "https://provider.example/oauth?state=state-1" });

    expect(openUrl).toHaveBeenCalledWith("https://provider.example/oauth?state=state-1");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("https://provider.example/oauth?state=state-1"),
      "OAuth sign-in",
    );
    await expect(handlers.onPrompt({ message: "Paste callback" })).resolves.toBe("callback-value");
  });

  it("forwards prompt cancellation to remote manual entry", async () => {
    const controller = new AbortController();
    const text = vi.fn(
      (params: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")), {
            once: true,
          });
        }),
    );
    const handlers = createVpsAwareOAuthHandlers({
      isRemote: true,
      prompter: {
        note: vi.fn(async () => undefined),
        text,
      } as unknown as WizardPrompter,
      runtime: { log: vi.fn() } as unknown as RuntimeEnv,
      spin: { update: vi.fn(), stop: vi.fn() } as ReturnType<WizardPrompter["progress"]>,
      openUrl: vi.fn(async () => undefined),
      localBrowserMessage: "Opening browser",
      manualPromptSignal: controller.signal,
    });

    await handlers.onAuth({ url: "https://provider.example/oauth?state=state-1" });
    const prompt = handlers.onPrompt({ message: "Paste callback" });
    controller.abort();

    await expect(prompt).rejects.toThrow("prompt aborted");
    expect(text).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });
});
