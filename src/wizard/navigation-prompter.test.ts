// Prompt navigation tests cover setup history replay and forward acceptance.
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  runWizardWithPromptNavigation,
  runWizardWithPromptNavigationScope,
} from "./navigation-prompter.js";
import type { WizardPrompter, WizardSelectParams } from "./prompts.js";
import { WizardNavigationError } from "./prompts.js";

function selectOptions(values: string[]) {
  return values.map((value) => ({ value, label: value }));
}

function selectParamsAt(select: ReturnType<typeof vi.fn>, index: number): WizardSelectParams {
  const params = select.mock.calls[index]?.[0];
  if (!params || typeof params !== "object") {
    throw new Error(`missing select call ${index}`);
  }
  return params as WizardSelectParams;
}

describe("runWizardWithPromptNavigation", () => {
  it("restarts at the previous prompt when back is requested", async () => {
    let firstPromptCalls = 0;
    let secondPromptCalls = 0;
    const select = vi.fn(async (params: WizardSelectParams) => {
      if (params.message === "First") {
        firstPromptCalls++;
        return firstPromptCalls === 1 ? "alpha" : "beta";
      }
      if (params.message === "Second") {
        secondPromptCalls++;
        if (secondPromptCalls === 1) {
          throw new WizardNavigationError("back");
        }
        return "two";
      }
      throw new Error(`unexpected prompt ${params.message}`);
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });
    let result: { first: string; second: string } | undefined;

    await runWizardWithPromptNavigation(prompter, async (navigationPrompter) => {
      const first = await navigationPrompter.select({
        message: "First",
        options: selectOptions(["alpha", "beta"]),
      });
      const second = await navigationPrompter.select({
        message: "Second",
        options: selectOptions(["one", "two"]),
      });
      result = { first, second };
    });

    expect(result).toEqual({ first: "beta", second: "two" });
    expect(select).toHaveBeenCalledTimes(4);
    expect(selectParamsAt(select as ReturnType<typeof vi.fn>, 2).navigation).toEqual({
      canGoBack: false,
      canGoForward: true,
    });
    expect(selectParamsAt(select as ReturnType<typeof vi.fn>, 3).navigation).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("uses right navigation to accept a remembered prompt answer", async () => {
    let thirdPromptCalls = 0;
    const note = vi.fn(async () => {});
    const select = vi.fn(async (params: WizardSelectParams) => {
      if (params.message === "First") {
        return "alpha";
      }
      if (params.message === "Second") {
        if (params.navigation?.canGoForward) {
          throw new WizardNavigationError("forward");
        }
        return "two";
      }
      if (params.message === "Third") {
        thirdPromptCalls++;
        if (thirdPromptCalls === 1) {
          throw new WizardNavigationError("back");
        }
        return "final";
      }
      throw new Error(`unexpected prompt ${params.message}`);
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ note, select });
    let result: { first: string; second: string; third: string } | undefined;

    await runWizardWithPromptNavigation(prompter, async (navigationPrompter) => {
      const first = await navigationPrompter.select({
        message: "First",
        options: selectOptions(["alpha"]),
      });
      await navigationPrompter.note("after first");
      const second = await navigationPrompter.select({
        message: "Second",
        options: selectOptions(["one", "two"]),
      });
      await navigationPrompter.note("after second");
      const third = await navigationPrompter.select({
        message: "Third",
        options: selectOptions(["final"]),
      });
      result = { first, second, third };
    });

    expect(result).toEqual({ first: "alpha", second: "two", third: "final" });
    expect(select).toHaveBeenCalledTimes(5);
    const secondReplayParams = selectParamsAt(select as ReturnType<typeof vi.fn>, 3);
    expect(secondReplayParams).toMatchObject({
      message: "Second",
      initialValue: "two",
      navigation: { canGoBack: true, canGoForward: true },
    });
    expect(note).toHaveBeenCalledTimes(3);
    expect(note).toHaveBeenNthCalledWith(1, "after first", undefined);
    expect(note).toHaveBeenNthCalledWith(2, "after second", undefined);
    expect(note).toHaveBeenNthCalledWith(3, "after second", undefined);
  });

  it("does not cache sensitive text answers for forward navigation", async () => {
    let thirdPromptCalls = 0;
    const select = vi.fn(async () => {
      thirdPromptCalls++;
      if (thirdPromptCalls === 1) {
        throw new WizardNavigationError("back");
      }
      return "done";
    }) as unknown as WizardPrompter["select"];
    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("secret-one")
      .mockResolvedValueOnce("secret-two");
    const prompter = createWizardPrompter({ select, text });
    let result: { secret: string; done: string } | undefined;

    await runWizardWithPromptNavigation(prompter, async (navigationPrompter) => {
      const secret = await navigationPrompter.text({
        message: "Secret",
        sensitive: true,
      });
      const done = await navigationPrompter.select({
        message: "Done",
        options: selectOptions(["done"]),
      });
      result = { secret, done };
    });

    expect(result).toEqual({ secret: "secret-two", done: "done" });
    expect(text).toHaveBeenCalledTimes(2);
    expect(text.mock.calls[1]?.[0]).toMatchObject({
      message: "Secret",
      navigation: { canGoBack: false, canGoForward: false },
    });
  });

  it("disables back replay for prompts after an irreversible boundary", async () => {
    const select = vi.fn(async (params: WizardSelectParams) => {
      if (params.message === "First") {
        return "alpha";
      }
      if (params.message === "Second") {
        throw new WizardNavigationError("back");
      }
      throw new Error(`unexpected prompt ${params.message}`);
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });

    await expect(
      runWizardWithPromptNavigation(prompter, async (navigationPrompter) => {
        await navigationPrompter.select({
          message: "First",
          options: selectOptions(["alpha"]),
        });
        navigationPrompter.disableBackNavigation?.();
        await navigationPrompter.select({
          message: "Second",
          options: selectOptions(["two"]),
        });
      }),
    ).rejects.toMatchObject({ direction: "back" });

    expect(select).toHaveBeenCalledTimes(2);
    expect(selectParamsAt(select as ReturnType<typeof vi.fn>, 1).navigation).toEqual({
      canGoBack: false,
      canGoForward: false,
    });
  });
});

describe("runWizardWithPromptNavigationScope", () => {
  it("returns a typed back outcome from the first prompt", async () => {
    const select = vi.fn(async () => {
      throw new WizardNavigationError("back");
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });

    const outcome = await runWizardWithPromptNavigationScope(prompter, async (scopedPrompter) => {
      await scopedPrompter.select({
        message: "First channel prompt",
        options: selectOptions(["continue"]),
      });
      return "completed";
    });

    expect(outcome).toEqual({ status: "back" });
    expect(selectParamsAt(select as ReturnType<typeof vi.fn>, 0).navigation).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("creates a fresh scope inside an outer wizard whose back history is disabled", async () => {
    const select = vi.fn(async () => {
      throw new WizardNavigationError("back");
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });
    let outcome: Awaited<ReturnType<typeof runWizardWithPromptNavigationScope<string>>> | undefined;

    await runWizardWithPromptNavigation(prompter, async (outerPrompter) => {
      outerPrompter.disableBackNavigation?.();
      outcome = await runWizardWithPromptNavigationScope(outerPrompter, async (scopedPrompter) => {
        await scopedPrompter.select({
          message: "First channel prompt",
          options: selectOptions(["continue"]),
        });
        return "completed";
      });
    });

    expect(outcome).toEqual({ status: "back" });
    expect(selectParamsAt(select as ReturnType<typeof vi.fn>, 0).navigation).toEqual({
      canGoBack: true,
      canGoForward: false,
    });
  });

  it("preserves optional client actions inside a navigation scope", async () => {
    const deviceCode = vi.fn(async () => undefined);
    const openUrl = vi.fn(async () => undefined);
    const prompter = createWizardPrompter({ deviceCode, openUrl });

    const outcome = await runWizardWithPromptNavigationScope(prompter, async (scopedPrompter) => {
      await scopedPrompter.deviceCode?.({ title: "Link device", code: "ABCD" });
      await scopedPrompter.openUrl?.("https://example.com/link");
      return "completed";
    });

    expect(outcome).toEqual({ status: "completed", value: "completed" });
    expect(deviceCode).toHaveBeenCalledWith({ title: "Link device", code: "ABCD" });
    expect(openUrl).toHaveBeenCalledWith("https://example.com/link");
  });
});
