/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dictationHarness = vi.hoisted(() => ({
  options: null as null | {
    onCommit: (transcript: string) => void;
    onTap: () => void;
  },
  controllers: [] as Array<{
    active: boolean;
    locksComposer: boolean;
    handlePointerDown: () => void;
  }>,
}));

vi.mock("../chat/composer-dictation.ts", () => ({
  ComposerDictationController: class {
    active = false;
    locksComposer = false;

    constructor(options: { onCommit: (transcript: string) => void; onTap: () => void }) {
      dictationHarness.options = options;
      dictationHarness.controllers.push(this);
    }
    update(options: { onCommit: (transcript: string) => void; onTap: () => void }) {
      dictationHarness.options = options;
    }
    dispose() {
      this.active = false;
    }
    handlePointerDown() {
      this.active = true;
    }
  },
}));

vi.mock("../chat/composer-microphone-picker.ts", () => ({
  ComposerMicrophonePicker: class {
    devices = [];
    loading = false;
    open = false;
    issue = null;
    handleOpen() {}
    handleClose() {}
    dispose() {}
  },
}));

import { NewSessionDictationControl } from "./composer-dictation-control.ts";

describe("NewSessionDictationControl", () => {
  beforeEach(() => {
    dictationHarness.options = null;
    dictationHarness.controllers = [];
  });

  it("drops a final transcript when cloud placement claims the draft in flight", () => {
    let canCommit = true;
    const insertTranscript = vi.fn(() => "spoken task");
    const onMessage = vi.fn();
    const control = new NewSessionDictationControl({
      textarea: { captureSelection: vi.fn(), insertTranscript } as never,
      getClient: () => ({}) as never,
      isConnected: () => true,
      canCommit: () => canCommit,
      onMessage,
      onError: vi.fn(),
      onClearError: vi.fn(),
      requestUpdate: vi.fn(),
    });

    control.render("agent-a");
    canCommit = false;
    dictationHarness.options?.onCommit("spoken task");

    expect(insertTranscript).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("clears its short-tap hint after a later dictation commits", () => {
    const onError = vi.fn();
    const onClearError = vi.fn();
    const onMessage = vi.fn();
    const control = new NewSessionDictationControl({
      textarea: {
        captureSelection: vi.fn(),
        insertTranscript: vi.fn(() => "spoken task"),
      } as never,
      getClient: () => ({}) as never,
      isConnected: () => true,
      canCommit: () => true,
      onMessage,
      onError,
      onClearError,
      requestUpdate: vi.fn(),
    });

    control.render("agent-a");
    dictationHarness.options?.onTap();
    const hint = "Hold the microphone to dictate, then release to insert what you said.";
    expect(onError).toHaveBeenCalledWith(hint);

    dictationHarness.options?.onCommit("spoken task");

    expect(onClearError).toHaveBeenCalledWith(hint);
    expect(onMessage).toHaveBeenCalledWith("spoken task");
  });

  it("cancels active dictation and drops its late transcript when the route owner changes", () => {
    const insertTranscript = vi.fn(() => "route B draft");
    const onMessage = vi.fn();
    const control = new NewSessionDictationControl({
      textarea: { captureSelection: vi.fn(), insertTranscript } as never,
      getClient: () => ({}) as never,
      isConnected: () => true,
      canCommit: () => true,
      onMessage,
      onError: vi.fn(),
      onClearError: vi.fn(),
      requestUpdate: vi.fn(),
    });

    control.render("agent-a");
    const routeAController = dictationHarness.controllers[0];
    routeAController?.handlePointerDown();
    const routeACommit = dictationHarness.options?.onCommit;

    control.render("agent-a");
    expect(dictationHarness.controllers).toHaveLength(1);
    expect(routeAController?.active).toBe(true);

    control.render("agent-b");
    routeACommit?.("late route A transcript");

    expect(routeAController?.active).toBe(false);
    expect(dictationHarness.controllers).toHaveLength(2);
    expect(insertTranscript).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("publishes whether dictation currently locks draft submission", () => {
    const control = new NewSessionDictationControl({
      textarea: { captureSelection: vi.fn(), insertTranscript: vi.fn() } as never,
      getClient: () => ({}) as never,
      isConnected: () => true,
      canCommit: () => true,
      onMessage: vi.fn(),
      onError: vi.fn(),
      onClearError: vi.fn(),
      requestUpdate: vi.fn(),
    });

    control.render("agent-a");
    expect(control.locked).toBe(false);

    const controller = dictationHarness.controllers[0];
    if (!controller) {
      throw new Error("expected dictation controller");
    }
    controller.locksComposer = true;

    expect(control.locked).toBe(true);
  });
});
