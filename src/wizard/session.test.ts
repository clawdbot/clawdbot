// Wizard session tests cover session creation and state transitions.

import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, test, vi } from "vitest";
import * as qrImage from "../media/qr-image.js";
import { DEVICE_CODE_PHISHING_WARNING } from "./prompts.js";
import type { WizardPrompter } from "./prompts.js";
import { WizardSession, wizardStepAwaitsInput, type WizardStep } from "./session.js";

function noteRunner() {
  return new WizardSession(async (prompter) => {
    await prompter.note("Welcome");
    const name = await prompter.text({ message: "Name" });
    await prompter.note(`Hello ${name}`);
  });
}

describe("WizardSession", () => {
  test.each([
    ["select", undefined, true],
    ["multiselect", undefined, true],
    ["text", undefined, true],
    ["confirm", undefined, true],
    ["action", "client", true],
    ["action", "gateway", false],
    ["note", undefined, false],
    ["progress", undefined, false],
  ] as const satisfies ReadonlyArray<
    readonly [WizardStep["type"], WizardStep["executor"], boolean]
  >)("classifies whether %s/%s awaits user input", (type, executor, expected) => {
    expect(wizardStepAwaitsInput({ id: "step", type, executor })).toBe(expected);
  });

  test("long-polls after delivering a QR, then settles and scrubs through its producer", async () => {
    let finish!: (account: string) => void;
    const settled = new Promise<string>((resolve) => {
      finish = resolve;
    });
    let releaseRunner!: () => void;
    const holdRunner = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let qrReturned!: () => void;
    const returned = new Promise<void>((resolve) => {
      qrReturned = resolve;
    });
    let account: string | undefined;
    const session = new WizardSession(
      async (prompter) => {
        account = await prompter.qrCode?.({
          title: "Link device",
          text: "sgnl://linkdevice?uuid=test",
          settled,
        });
        qrReturned();
        await holdRunner;
      },
      { supportsQrCode: true },
    );

    const presented = await session.next({ supportsQrCode: true });
    expect(presented.step).toMatchObject({
      type: "qr",
      executor: "gateway",
      canCancel: true,
    });
    if (!presented.step) {
      throw new Error("expected QR step");
    }
    expect(wizardStepAwaitsInput(presented.step)).toBe(false);
    await expect(session.answer(presented.step.id, true)).rejects.toThrow(
      "wizard: QR steps settle through their producer",
    );

    let pollCompleted = false;
    const poll = session.next({ supportsQrCode: true }).finally(() => {
      pollCompleted = true;
    });
    await Promise.resolve();
    expect(pollCompleted).toBe(false);

    finish("+15555550123");
    await returned;
    expect(session.cancel()).toBe(false);
    releaseRunner();
    await session.whenSettled();

    expect(account).toBe("+15555550123");
    expect(presented.step.qrDataUrl).toBeUndefined();
    await expect(poll).resolves.toMatchObject({ done: true, status: "done" });
  });

  test("does not project a QR when its producer settles during rendering", async () => {
    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    let markRenderStarted!: () => void;
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    const render = vi
      .spyOn(qrImage, "renderQrPngDataUrlWithinLimit")
      .mockImplementationOnce(async () => {
        markRenderStarted();
        await renderGate;
        return "data:image/png;base64,cXItcG5n";
      });
    try {
      let finish!: (account: string) => void;
      const settled = new Promise<string>((resolve) => {
        finish = resolve;
      });
      let account: string | undefined;
      const session = new WizardSession(
        async (prompter) => {
          account = await prompter.qrCode?.({
            title: "Link device",
            text: "sgnl://linkdevice?uuid=test",
            settled,
          });
        },
        { supportsQrCode: true },
      );

      await renderStarted;
      const next = session.next({ supportsQrCode: true });
      finish("+15555550123");
      await Promise.resolve();
      releaseRender();

      await expect(next).resolves.toMatchObject({ done: true, status: "done" });
      expect(account).toBe("+15555550123");
    } finally {
      render.mockRestore();
    }
  });

  test("retires an expired QR before delayed timer cleanup can project it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const session = new WizardSession(
        async (prompter) => {
          await prompter.qrCode?.({
            title: "Link device",
            text: "sgnl://linkdevice?uuid=expired",
            expiresInMs: 100,
            settled: new Promise(() => {}),
          });
        },
        { supportsQrCode: true },
      );

      const presented = await session.next({ supportsQrCode: true });
      expect(presented.step).toMatchObject({ type: "qr", qrExpiresAtMs: 1_100 });
      if (!presented.step) {
        throw new Error("expected QR step");
      }

      // Advance the wall clock without running the scheduled expiry callback.
      vi.setSystemTime(1_101);
      expect(session.projectStepForClient(presented.step)).toBeNull();
      await expect(session.next({ supportsQrCode: true })).resolves.toMatchObject({
        done: true,
        status: "error",
        error: "Error: wizard: QR presentation expired; restart setup to retry",
      });
      expect(presented.step?.qrDataUrl).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("bounds QR deadlines to the timer-safe maximum", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const accepted = new WizardSession(
        async (prompter) => {
          await prompter.qrCode?.({
            title: "Link device",
            text: "sgnl://linkdevice?uuid=max",
            expiresInMs: MAX_TIMER_TIMEOUT_MS,
            settled: new Promise(() => {}),
          });
        },
        { supportsQrCode: true },
      );
      await expect(accepted.next({ supportsQrCode: true })).resolves.toMatchObject({
        step: { type: "qr", qrExpiresAtMs: 1_000 + MAX_TIMER_TIMEOUT_MS },
      });
      accepted.cancel();
      await accepted.whenSettled();
    } finally {
      vi.useRealTimers();
    }

    let rejected: unknown;
    const session = new WizardSession(
      async (prompter) => {
        try {
          await prompter.qrCode?.({
            title: "Link device",
            text: "sgnl://linkdevice?uuid=overflow",
            expiresInMs: MAX_TIMER_TIMEOUT_MS + 1,
            settled: new Promise(() => {}),
          });
        } catch (error) {
          rejected = error;
        }
      },
      { supportsQrCode: true },
    );

    await session.whenSettled();

    expect(rejected).toBeInstanceOf(RangeError);
  });

  test("cancels and scrubs a delivered QR without exposing the capability by default", async () => {
    let unsupportedQrCode: WizardPrompter["qrCode"];
    const unsupported = new WizardSession(async (prompter) => {
      unsupportedQrCode = prompter.qrCode;
    });
    await unsupported.whenSettled();
    expect(unsupportedQrCode).toBeUndefined();

    const session = new WizardSession(
      async (prompter) => {
        await prompter.qrCode?.({
          title: "Link device",
          text: "sgnl://linkdevice?uuid=test",
          settled: new Promise(() => {}),
        });
      },
      { supportsQrCode: true },
    );
    const presented = await session.next({ supportsQrCode: true });
    expect(presented.step?.type).toBe("qr");

    session.cancel();
    await session.whenSettled();

    expect(presented.step?.qrDataUrl).toBeUndefined();
    await expect(session.next()).resolves.toMatchObject({ done: true, status: "cancelled" });
  });

  test("marks a QR as non-cancellable after the durable commit point", async () => {
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new WizardSession(
      async (prompter, _signal, owner) => {
        owner.lockCancellation();
        await prompter.qrCode?.({
          title: "Link device",
          text: "sgnl://linkdevice?uuid=test",
          settled,
        });
      },
      { supportsQrCode: true },
    );

    const presented = await session.next({ supportsQrCode: true });
    expect(presented.step).toMatchObject({ type: "qr", canCancel: false });
    expect(session.cancel()).toBe(false);

    finish();
    await expect(session.next({ supportsQrCode: true })).resolves.toMatchObject({
      done: true,
      status: "done",
    });
  });

  test("steps progress in order", async () => {
    const session = noteRunner();

    const first = await session.next();
    expect(first.done).toBe(false);
    expect(first.step?.type).toBe("note");

    const secondPeek = await session.next();
    expect(secondPeek.step?.id).toBe(first.step?.id);

    if (!first.step) {
      throw new Error("expected first step");
    }
    await session.answer(first.step.id, null);

    const second = await session.next();
    expect(second.done).toBe(false);
    expect(second.step?.type).toBe("text");

    if (!second.step) {
      throw new Error("expected second step");
    }
    await session.answer(second.step.id, "Peter");

    const third = await session.next();
    expect(third.step?.type).toBe("note");

    if (!third.step) {
      throw new Error("expected third step");
    }
    await session.answer(third.step.id, null);

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("plain output is a client note with plain format", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.plain?.('{"ok":true}');
    });

    const first = await session.next();
    if (!first.step) {
      throw new Error("expected plain note");
    }
    expect(first.step.type).toBe("note");
    expect(first.step.message).toBe('{"ok":true}');
    expect(first.step.format).toBe("plain");
    await session.answer(first.step.id, null);
    const done = await session.next();
    expect(done.done).toBe(true);
  });

  test("returns the exact prepared model only on the terminal result", async () => {
    const session = new WizardSession(async (_prompter, _signal, owner) => {
      owner.setPreparedModelRef("ollama/qwen3:0.6b");
    });

    await expect(session.next()).resolves.toEqual({
      done: true,
      status: "done",
      preparedModelRef: "ollama/qwen3:0.6b",
    });
  });

  test("does not expose a prepared model when the wizard fails", async () => {
    const session = new WizardSession(async (_prompter, _signal, owner) => {
      owner.setPreparedModelRef("ollama/qwen3:0.6b");
      throw new Error("activation setup failed");
    });

    await expect(session.next()).resolves.toMatchObject({
      done: true,
      status: "error",
      error: "Error: activation setup failed",
    });
    expect(await session.next()).not.toHaveProperty("preparedModelRef");
  });

  test("attaches an explicit browser destination to the next client step", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.openUrl?.("https://provider.example/oauth?state=state-1");
      await prompter.text({ message: "Paste the redirect URL" });
    });

    const first = await session.next();
    expect(first.step?.externalUrl).toBe("https://provider.example/oauth?state=state-1");
    expect(first.step?.type).toBe("text");
    if (!first.step) {
      throw new Error("expected provider sign-in step");
    }
    await session.answer(first.step.id, "http://localhost/callback?code=done");
    expect((await session.next()).status).toBe("done");
  });

  test("carries device-code presentation without parsing provider prose", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.openUrl?.("https://provider.example/device");
      await prompter.deviceCode?.({
        title: "Provider sign-in",
        code: "ABCD-1234",
        expiresInMinutes: 15,
        message: "Enter this one-time code in your browser.",
      });
    });

    const first = await session.next();
    expect(first.step).toMatchObject({
      type: "note",
      title: "Provider sign-in",
      message: [
        "Enter this one-time code in your browser.",
        "Code: ABCD-1234",
        "Code expires in 15 minutes.",
        DEVICE_CODE_PHISHING_WARNING,
      ].join("\n"),
      externalUrl: "https://provider.example/device",
      deviceCode: {
        code: "ABCD-1234",
        expiresInMinutes: 15,
        message: "Enter this one-time code in your browser.",
      },
    });
  });

  test("invalid answers throw", async () => {
    const session = noteRunner();
    const first = await session.next();
    await expect(session.answer("bad-id", null)).rejects.toThrow(/wizard: no pending step/i);
    if (!first.step) {
      throw new Error("expected first step");
    }
    await session.answer(first.step.id, null);
  });

  test("keeps a validated text step pending after an invalid answer", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({
        message: "Port",
        validate: (value) => (value === "18789" ? undefined : "Enter the expected port"),
      });
    });

    const first = await session.next();
    if (!first.step) {
      throw new Error("expected text step");
    }
    await expect(session.answer(first.step.id, "banana")).resolves.toBe("Enter the expected port");
    expect(session.getStatus()).toBe("running");
    expect((await session.next()).step?.id).toBe(first.step.id);

    await session.answer(first.step.id, "18789");
    expect((await session.next()).status).toBe("done");
  });

  test("rejects non-scalar text answers before validation and resolution", async () => {
    let resolved: string | undefined;
    const session = new WizardSession(async (prompter) => {
      resolved = await prompter.text({
        message: "Token",
        validate: (value) => (value.length > 0 ? undefined : "Token is required"),
      });
    });

    const first = await session.next();
    if (!first.step) {
      throw new Error("expected text step");
    }
    await expect(session.answer(first.step.id, ["token"])).resolves.toBe(
      "wizard: text answer must be a scalar value",
    );
    expect((await session.next()).step?.id).toBe(first.step.id);

    await session.answer(first.step.id, "token");
    expect((await session.next()).status).toBe("done");
    expect(resolved).toBe("token");
  });

  test("cancel marks session and unblocks", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "Name" });
    });

    const step = await session.next();
    expect(step.step?.type).toBe("text");

    session.cancel();

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("cancelled");
    expect(session.signal.aborted).toBe(true);
  });

  test("refuses cancellation after the durable commit point", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new WizardSession(async () => {
      await gate;
    });

    session.lockCancellation();
    expect(session.cancel()).toBe(false);
    expect(session.getStatus()).toBe("running");
    expect(session.signal.aborted).toBe(false);

    finish();
    expect((await session.next()).status).toBe("done");
  });

  test("expires an abandoned interactive session", async () => {
    vi.useFakeTimers();
    try {
      const session = new WizardSession(
        async (prompter) => {
          await prompter.text({ message: "Name" });
        },
        { timeoutMs: 1_000 },
      );

      expect((await session.next()).step?.type).toBe("text");
      await vi.advanceTimersByTimeAsync(1_000);

      const done = await session.next();
      expect(done.status).toBe("cancelled");
      expect(session.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a runner finishing after cancellation cannot overwrite cancelled state", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = new WizardSession(async () => {
      await gate;
    });

    session.cancel();
    finish();
    await Promise.resolve();

    expect((await session.next()).status).toBe("cancelled");
  });

  test("does not lose terminal completion when the last answer finishes the runner immediately", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "Token" });
    });

    const first = await session.next();
    expect(first.step?.type).toBe("text");
    if (!first.step) {
      throw new Error("expected first step");
    }

    await session.answer(first.step.id, "ok");
    await Promise.resolve();

    const done = await session.next();
    expect(done.done).toBe(true);
    expect(done.status).toBe("done");
  });

  test("forwards sensitive flag to the emitted text step", async () => {
    const session = new WizardSession(async (prompter) => {
      await prompter.text({ message: "API key", sensitive: true });
      await prompter.text({ message: "Username" });
    });

    const sensitiveStep = (await session.next()).step;
    expect(sensitiveStep?.type).toBe("text");
    expect(sensitiveStep?.sensitive).toBe(true);
    if (!sensitiveStep) {
      throw new Error("expected sensitive step");
    }
    await session.answer(sensitiveStep.id, "fake-key-aa11");

    const plainStep = (await session.next()).step;
    expect(plainStep?.type).toBe("text");
    expect(plainStep?.sensitive).toBeUndefined();
    if (!plainStep) {
      throw new Error("expected plain step");
    }
    await session.answer(plainStep.id, "alice");
  });

  test("bridges confirm, progress updates, and notes in order", async () => {
    let markInitialUpdateQueued!: () => void;
    const initialUpdateQueued = new Promise<void>((resolve) => {
      markInitialUpdateQueued = resolve;
    });
    let releaseHalfway!: () => void;
    const halfway = new Promise<void>((resolve) => {
      releaseHalfway = resolve;
    });
    let releaseDone!: () => void;
    const done = new Promise<void>((resolve) => {
      releaseDone = resolve;
    });
    const session = new WizardSession(async (prompter) => {
      await prompter.confirm({ message: "Download model?", initialValue: false });
      const progress = prompter.progress("Starting download");
      progress.update("Downloading model... 10%");
      markInitialUpdateQueued();
      await halfway;
      progress.update("Downloading model... 50%");
      await done;
      progress.stop("Model downloaded");
      await prompter.note("Ready to use", "Prepared");
    });

    const confirm = await session.next();
    expect(confirm.step).toMatchObject({
      type: "confirm",
      message: "Download model?",
      initialValue: false,
    });
    if (!confirm.step) {
      throw new Error("expected confirm step");
    }
    await session.answer(confirm.step.id, true);
    await initialUpdateQueued;

    expect(await session.next()).toMatchObject({
      step: {
        type: "progress",
        message: "Starting download",
        executor: "gateway",
      },
    });

    expect(await session.next()).toMatchObject({
      step: { type: "progress", message: "Downloading model... 10%" },
    });

    const halfwayStep = session.next();
    releaseHalfway();
    expect(await halfwayStep).toMatchObject({
      step: { type: "progress", message: "Downloading model... 50%" },
    });

    const doneStep = session.next();
    releaseDone();
    const completedProgress = await doneStep;
    expect(completedProgress).toMatchObject({
      step: { type: "progress", message: "Model downloaded" },
    });
    if (!completedProgress.step) {
      throw new Error("expected completed progress step");
    }
    await expect(session.answer(completedProgress.step.id, undefined)).resolves.toBeUndefined();

    expect(await session.next()).toMatchObject({
      step: { type: "note", title: "Prepared", message: "Ready to use" },
    });
  });
});
