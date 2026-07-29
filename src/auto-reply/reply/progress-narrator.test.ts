// Progress narrator tests cover trigger policy, gating, and reply-option wiring.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROGRESS_STATUS_PREAMBLE_FRESH_MS } from "../../channels/progress-draft-compositor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { ProgressNarrationInput } from "./progress-narrator-model.js";

const narratorWarnSpy = vi.hoisted(() => vi.fn());
const narrationModelMocks = vi.hoisted(() => ({
  generate: vi.fn(),
}));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: narratorWarnSpy,
    }),
  };
});

vi.mock("./progress-narrator-model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./progress-narrator-model.js")>();
  return {
    ...actual,
    prepareNarrationModel: vi.fn(async () => ({
      selection: { provider: "openai", modelId: "gpt-5.5-mini" },
      model: {},
      auth: {},
    })),
    generateNarrationWithUtilityModel: vi.fn(
      async ({ input }: { input: ProgressNarrationInput }) => ({
        text: await narrationModelMocks.generate(input),
      }),
    ),
  };
});

import { attachProgressNarratorToReplyOptions } from "./progress-narrator.js";

const cfg = {} as OpenClawConfig;
const narratorCfg = {
  agents: { defaults: { utilityModel: "openai/gpt-5.5-mini" } },
} as OpenClawConfig;

// The narrator runs generations on a detached promise; drain microtasks so
// onUpdate assertions observe the settled state.
async function flushNarrations() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function createNarratorHarness(params?: {
  texts?: Array<string | null>;
  generate?: (input: ProgressNarrationInput) => Promise<string | null>;
  now?: () => number;
  hideCommandText?: boolean;
  isProgressDraftVisible?: () => boolean;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}) {
  const inputs: ProgressNarrationInput[] = [];
  const texts = params?.texts ?? ["Working on the request."];
  const generate = vi.fn(async (input: ProgressNarrationInput) => {
    inputs.push(input);
    return params?.generate
      ? await params.generate(input)
      : (texts[Math.min(inputs.length - 1, texts.length - 1)] ?? null);
  });
  const onUpdate = vi.fn();
  if (params?.now) {
    vi.spyOn(Date, "now").mockImplementation(params.now);
  }
  const lifecycleRef: {
    current?: Parameters<NonNullable<InternalGetReplyOptions["onProgressNarratorLifecycle"]>>[0];
  } = {};
  narrationModelMocks.generate.mockImplementation(generate);
  const wrapped = attachProgressNarratorToReplyOptions({
    cfg: narratorCfg,
    agentId: "main",
    userMessage: "change the default model",
    opts: {
      onNarrationUpdate: onUpdate,
      onToolStart: vi.fn(),
      onCommandOutput: vi.fn(),
      onItemEvent: vi.fn(),
      onProgressNarratorLifecycle: (value) => {
        lifecycleRef.current = value;
      },
      isProgressDraftVisible: params?.isProgressDraftVisible,
      narrationHideCommandText: params?.hideCommandText,
    },
  });
  if (!wrapped || !lifecycleRef.current) {
    throw new Error("expected attached progress narrator");
  }
  const controls = lifecycleRef.current;
  const narrator = {
    beginTurn: () => controls.beginTurn(),
    stopTurn: () => controls.stopTurn(),
    noteToolStart: (
      payload: Parameters<NonNullable<InternalGetReplyOptions["onToolStart"]>>[0],
    ) => {
      void wrapped.onToolStart?.(payload);
    },
    noteCommandOutput: (
      payload: Parameters<NonNullable<InternalGetReplyOptions["onCommandOutput"]>>[0],
    ) => {
      void wrapped.onCommandOutput?.(payload);
    },
    noteItemEvent: (
      payload: Parameters<NonNullable<InternalGetReplyOptions["onItemEvent"]>>[0],
    ) => {
      void wrapped.onItemEvent?.(payload);
    },
  };
  return { narrator, generate, onUpdate, inputs };
}

afterEach(() => {
  vi.restoreAllMocks();
  narrationModelMocks.generate.mockReset();
});

describe("progress narration through reply options", () => {
  it("narrates after the first work tool event", async () => {
    const { narrator, generate, onUpdate, inputs } = createNarratorHarness();

    narrator.noteToolStart({ name: "exec", phase: "start", args: { command: "ls" } });
    await flushNarrations();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ text: "Working on the request." });
    expect(inputs[0]?.userMessage).toBe("change the default model");
    expect(inputs[0]?.activityNotes).toContain('Tool exec: {"command":"ls"}');
  });

  it("ignores non-work tools and non-start phases", async () => {
    const { narrator, generate } = createNarratorHarness();

    narrator.noteToolStart({ name: "message", phase: "start" });
    narrator.noteToolStart({ name: "exec", phase: "end" });
    await flushNarrations();

    expect(generate).not.toHaveBeenCalled();
  });

  it("retries buffered notes after visibility flips without a new note", async () => {
    vi.useFakeTimers();
    try {
      let visible = false;
      const { narrator, generate, inputs } = createNarratorHarness({
        isProgressDraftVisible: () => visible,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      narrator.noteToolStart({ name: "exec", phase: "start", args: { command: "first" } });
      narrator.noteToolStart({ name: "exec", phase: "start", args: { command: "second" } });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(generate).not.toHaveBeenCalled();

      visible = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await flushNarrations();

      expect(generate).toHaveBeenCalledTimes(1);
      expect(inputs[0]?.activityNotes.join("\n")).toContain("first");
      expect(inputs[0]?.activityNotes.join("\n")).toContain("second");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds hidden-draft retries and re-arms them after new activity", async () => {
    vi.useFakeTimers();
    try {
      const { narrator, generate } = createNarratorHarness({
        isProgressDraftVisible: () => false,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      narrator.noteToolStart({ name: "exec", phase: "start" });
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(generate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      narrator.noteToolStart({ name: "read", phase: "start" });
      expect(vi.getTimerCount()).toBe(1);
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an immediate failure retry while the draft is hidden", async () => {
    vi.useFakeTimers();
    try {
      let visible = true;
      const { narrator, generate } = createNarratorHarness({
        texts: ["Running a command.", "The command failed."],
        isProgressDraftVisible: () => visible,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      narrator.noteToolStart({ name: "exec", phase: "start" });
      await flushNarrations();
      expect(generate).toHaveBeenCalledTimes(1);

      visible = false;
      narrator.noteCommandOutput({ name: "exec", phase: "end", exitCode: 1 });
      visible = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await flushNarrations();

      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels retries at final and resets preamble freshness for a queued turn", async () => {
    vi.useFakeTimers();
    try {
      let visible = false;
      const { narrator, generate, inputs } = createNarratorHarness({
        isProgressDraftVisible: () => visible,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      narrator.noteItemEvent({ kind: "preamble", progressText: "Primary turn work." });
      narrator.noteToolStart({ name: "exec", phase: "start" });
      expect(vi.getTimerCount()).toBe(1);

      narrator.stopTurn();
      expect(vi.getTimerCount()).toBe(0);
      narrator.beginTurn();
      visible = true;
      narrator.noteToolStart({ name: "read", phase: "start" });
      await flushNarrations();

      expect(generate).toHaveBeenCalledTimes(1);
      expect(inputs[0]?.userMessage).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a utility-model result that settles after the turn stops", async () => {
    let resolveGeneration: ((text: string) => void) | undefined;
    const { narrator, onUpdate } = createNarratorHarness({
      generate: () =>
        new Promise<string>((resolve) => {
          resolveGeneration = resolve;
        }),
    });

    narrator.noteToolStart({ name: "exec", phase: "start" });
    narrator.stopTurn();
    resolveGeneration?.("Stale status.");
    await flushNarrations();

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("retries narration after preamble freshness expires without a new note", async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 0;
      const { narrator, generate, inputs } = createNarratorHarness({
        now: () => nowMs,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      narrator.noteItemEvent({
        kind: "preamble",
        progressText: "Checking   the current configuration.",
      });
      narrator.noteToolStart({ name: "read", phase: "start" });
      await flushNarrations();
      expect(generate).not.toHaveBeenCalled();

      nowMs = PROGRESS_STATUS_PREAMBLE_FRESH_MS + 1;
      await vi.advanceTimersByTimeAsync(PROGRESS_STATUS_PREAMBLE_FRESH_MS + 1);
      await flushNarrations();

      expect(generate).toHaveBeenCalledTimes(1);
      expect(inputs[0]?.activityNotes).toContain("Assistant: Checking the current configuration.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let silent or directive-only preambles suppress narration", async () => {
    vi.useFakeTimers();
    try {
      const { narrator, generate, inputs } = createNarratorHarness({
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      narrator.noteItemEvent({ kind: "preamble", progressText: "[[reply_to_current]]" });
      narrator.noteItemEvent({
        kind: "preamble",
        progressText: "[[audio_as_voice]] _NO_REPLY_",
      });
      narrator.noteToolStart({ name: "exec", phase: "start", args: { command: "ls" } });
      await flushNarrations();

      expect(generate).toHaveBeenCalledTimes(1);
      expect(inputs[0]?.activityNotes.some((note) => note.startsWith("model:"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("batches follow-up events until the event threshold", async () => {
    const nowMs = 0;
    const { narrator, generate } = createNarratorHarness({ now: () => nowMs });

    narrator.noteToolStart({ name: "exec", phase: "start" });
    await flushNarrations();
    expect(generate).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 3; i += 1) {
      narrator.noteToolStart({ name: "exec", phase: "start" });
    }
    await flushNarrations();
    expect(generate).toHaveBeenCalledTimes(1);

    narrator.noteToolStart({ name: "exec", phase: "start" });
    await flushNarrations();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("re-narrates after the interval with a single new event", async () => {
    let nowMs = 0;
    const { narrator, generate } = createNarratorHarness({ now: () => nowMs });

    narrator.noteToolStart({ name: "exec", phase: "start" });
    await flushNarrations();
    expect(generate).toHaveBeenCalledTimes(1);

    nowMs += 13_000;
    narrator.noteToolStart({ name: "exec", phase: "start" });
    await flushNarrations();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("narrates metadata-only command failures immediately", async () => {
    const { narrator, generate, onUpdate, inputs } = createNarratorHarness({
      texts: ["Running a command.", "The command failed, retrying."],
    });

    narrator.noteToolStart({ name: "exec", phase: "start" });
    await flushNarrations();
    narrator.noteCommandOutput({
      name: "exec",
      title: "pnpm test",
      phase: "end",
      exitCode: 1,
      output: "private command output must not reach narration",
    });
    await flushNarrations();

    expect(generate).toHaveBeenCalledTimes(2);
    const notes = inputs[1]?.activityNotes.join("\n") ?? "";
    expect(notes).toContain("pnpm test: failed (exit 1)");
    expect(notes).not.toContain("private command output");
    expect(onUpdate).toHaveBeenLastCalledWith({ text: "The command failed, retrying." });
  });

  it("drops duplicate narration text", async () => {
    let nowMs = 0;
    const { narrator, onUpdate } = createNarratorHarness({
      texts: ["Same status."],
      now: () => nowMs,
    });

    narrator.noteToolStart({ name: "exec", phase: "start" });
    await flushNarrations();
    nowMs += 13_000;
    narrator.noteToolStart({ name: "exec", phase: "start" });
    await flushNarrations();

    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("disables after consecutive failed generations and warns once", async () => {
    narratorWarnSpy.mockClear();
    let nowMs = 0;
    const { narrator, generate, onUpdate } = createNarratorHarness({
      texts: [null],
      now: () => nowMs,
    });

    for (let i = 0; i < 4; i += 1) {
      narrator.noteToolStart({ name: "exec", phase: "start" });
      await flushNarrations();
      nowMs += 13_000;
    }

    expect(generate).toHaveBeenCalledTimes(2);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(narratorWarnSpy).toHaveBeenCalledTimes(1);
    expect(String(narratorWarnSpy.mock.calls[0]?.[0])).toContain(
      "narration disabled after 2 consecutive failures",
    );
  });

  it("clears rendered narration when it disables after failures", async () => {
    let nowMs = 0;
    const { narrator, onUpdate } = createNarratorHarness({
      texts: ["Status one.", null, null],
      now: () => nowMs,
    });

    for (let i = 0; i < 3; i += 1) {
      narrator.noteToolStart({ name: "exec", phase: "start" });
      await flushNarrations();
      nowMs += 13_000;
    }

    // Success, then two failed generations: the disable path must clear the
    // stale narration so the draft falls back to raw tool lines.
    expect(onUpdate).toHaveBeenNthCalledWith(1, { text: "Status one." });
    expect(onUpdate).toHaveBeenLastCalledWith({ text: "" });
  });

  it("omits exec command text and failure titles when the channel hides command text", async () => {
    const { narrator, inputs } = createNarratorHarness({ hideCommandText: true });

    narrator.noteToolStart({
      name: "exec",
      phase: "start",
      args: { command: "cat /etc/hosts" },
    });
    narrator.noteToolStart({
      name: "shell",
      phase: "start",
      args: { command: "cat /etc/hosts" },
    });
    await flushNarrations();
    narrator.noteCommandOutput({
      name: "exec",
      title: "cat /etc/hosts",
      phase: "end",
      exitCode: 1,
    });
    await flushNarrations();

    const notes = inputs.at(-1)?.activityNotes.join("\n") ?? "";
    expect(notes).not.toContain("/etc/hosts");
    expect(notes).toContain("exec: failed (exit 1)");
  });

  it("normalizes narration text to one bounded plain line", async () => {
    const long = `"${Array.from({ length: 80 }, (_v, i) => `word${i}`).join(" ")}\nsecond line"`;
    const { narrator, onUpdate } = createNarratorHarness({ texts: [long] });

    narrator.noteToolStart({ name: "exec", phase: "start" });
    await flushNarrations();

    const text = onUpdate.mock.calls[0]?.[0]?.text as string;
    expect(text).not.toContain("\n");
    expect(text.startsWith('"')).toBe(false);
    expect(Array.from(text).length).toBeLessThanOrEqual(280);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("attachProgressNarratorToReplyOptions", () => {
  const utilityCfg = {
    agents: { defaults: { utilityModel: "openai/gpt-5.5-mini" } },
  } as OpenClawConfig;

  it("returns options unchanged without a narration callback", () => {
    const opts: GetReplyOptions = { onToolStart: vi.fn() };
    expect(attachProgressNarratorToReplyOptions({ cfg: utilityCfg, agentId: "main", opts })).toBe(
      opts,
    );
  });

  it("returns options unchanged without a resolvable utility model", () => {
    // Bare config: no explicit utilityModel and no plugin metadata snapshot to
    // derive a provider default from.
    const opts: GetReplyOptions = { onNarrationUpdate: vi.fn(), onToolStart: vi.fn() };
    expect(attachProgressNarratorToReplyOptions({ cfg, agentId: "main", opts })).toBe(opts);
  });

  it("returns options unchanged when utility routing is explicitly disabled", () => {
    const disabledCfg = {
      agents: { defaults: { utilityModel: "" } },
    } as OpenClawConfig;
    const opts: GetReplyOptions = { onNarrationUpdate: vi.fn(), onToolStart: vi.fn() };
    expect(attachProgressNarratorToReplyOptions({ cfg: disabledCfg, agentId: "main", opts })).toBe(
      opts,
    );
  });

  it("returns options unchanged for model-locked native sessions", () => {
    const opts: GetReplyOptions = { onNarrationUpdate: vi.fn(), onToolStart: vi.fn() };
    expect(
      attachProgressNarratorToReplyOptions({
        cfg: utilityCfg,
        agentId: "main",
        opts,
        disabled: true,
      }),
    ).toBe(opts);
  });
  it("tees tool events while preserving the channel callback results", async () => {
    const onToolStart = vi.fn(async () => {});
    const onItemEvent = vi.fn(() => false as const);
    const opts: InternalGetReplyOptions = {
      onNarrationUpdate: vi.fn(),
      onToolStart,
      onItemEvent,
    };

    const wrapped = attachProgressNarratorToReplyOptions({
      cfg: utilityCfg,
      agentId: "main",
      userMessage: "hi",
      opts,
    });

    expect(wrapped).not.toBe(opts);
    // Non-work tool: the narrator ignores it, the channel still hears it.
    await wrapped?.onToolStart?.({ name: "message", phase: "start" });
    expect(onToolStart).toHaveBeenCalledWith({ name: "message", phase: "start" });
    await expect(
      Promise.resolve(wrapped?.onItemEvent?.({ itemId: "i1", status: "completed" })),
    ).resolves.toBe(false);
    expect(onItemEvent).toHaveBeenCalledWith({ itemId: "i1", status: "completed" });
  });

  it("exposes turn lifecycle controls to the channel", () => {
    const onProgressNarratorLifecycle = vi.fn();
    const opts: InternalGetReplyOptions = {
      onNarrationUpdate: vi.fn(),
      onProgressNarratorLifecycle,
    };

    attachProgressNarratorToReplyOptions({ cfg: utilityCfg, agentId: "main", opts });

    expect(onProgressNarratorLifecycle).toHaveBeenCalledOnce();
    expect(onProgressNarratorLifecycle.mock.calls[0]?.[0]).toEqual({
      beginTurn: expect.any(Function),
      stopTurn: expect.any(Function),
    });
  });
});
