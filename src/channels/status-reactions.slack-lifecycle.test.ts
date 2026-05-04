import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStatusReactionController,
  DEFAULT_EMOJIS,
  type StatusReactionAdapter,
} from "./status-reactions.js";

const EXEC_TOOL_EMOJI = "🛠️";
const WEB_SEARCH_TOOL_EMOJI = "🔎";

function createSlackMockAdapter() {
  const active = new Set<string>();
  const log: string[] = [];

  return {
    adapter: {
      setReaction: vi.fn(async (emoji: string) => {
        if (active.has(emoji)) {
          throw new Error("already_reacted");
        }
        active.add(emoji);
        log.push(`+${emoji}`);
      }),
      removeReaction: vi.fn(async (emoji: string) => {
        if (!active.has(emoji)) {
          throw new Error("no_reaction");
        }
        active.delete(emoji);
        log.push(`-${emoji}`);
      }),
    } as StatusReactionAdapter,
    active,
    log,
  };
}

describe("Slack status reaction lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queued -> thinking -> tool -> done -> clear", async () => {
    const { adapter, active, log } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has("eyes")).toBe(true);

    void ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has(DEFAULT_EMOJIS.thinking)).toBe(true);
    expect(active.has("eyes")).toBe(true);

    void ctrl.setTool("web_search");
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has(WEB_SEARCH_TOOL_EMOJI)).toBe(true);
    expect(active.has(DEFAULT_EMOJIS.thinking)).toBe(true);

    await ctrl.setDone();
    expect(active.has(DEFAULT_EMOJIS.done)).toBe(true);
    expect(active.has(WEB_SEARCH_TOOL_EMOJI)).toBe(false);
    expect(active.has(DEFAULT_EMOJIS.thinking)).toBe(false);

    await ctrl.clear();
    expect(active.size).toBe(0);
    expect(log.length).toBeGreaterThan(0);
  });

  it("queued -> error -> restoreInitial", async () => {
    const { adapter, active } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has("eyes")).toBe(true);

    await ctrl.setError();
    expect(active.has(DEFAULT_EMOJIS.error)).toBe(true);
    expect(active.has("eyes")).toBe(false);

    await ctrl.restoreInitial();
    expect(active.has("eyes")).toBe(true);
    expect(active.has(DEFAULT_EMOJIS.error)).toBe(false);
  });

  it("restoreInitial clears stall timers without re-adding queued emoji", async () => {
    const { adapter, active } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      timing: { debounceMs: 0, stallSoftMs: 10, stallHardMs: 20 },
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(1);
    expect(active.has("eyes")).toBe(true);
    expect(adapter.setReaction).toHaveBeenCalledTimes(1);

    await ctrl.restoreInitial();
    await vi.advanceTimersByTimeAsync(30);

    expect(adapter.setReaction).toHaveBeenCalledTimes(1);
    expect(active.has("eyes")).toBe(true);
    expect(active.has(DEFAULT_EMOJIS.stallSoft)).toBe(false);
    expect(active.has(DEFAULT_EMOJIS.stallHard)).toBe(false);
  });

  it("restoreInitial removes extra active reactions when current emoji is already initial", async () => {
    const { adapter, active } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    void ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(10);
    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has(DEFAULT_EMOJIS.thinking)).toBe(true);
    expect(active.has("eyes")).toBe(true);

    await ctrl.restoreInitial();

    expect(active.has("eyes")).toBe(true);
    expect(active.has(DEFAULT_EMOJIS.thinking)).toBe(false);
  });

  it("restoreInitial removes only tracked active reactions", async () => {
    const { adapter, active } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(10);
    await ctrl.setDone();

    await ctrl.restoreInitial();

    expect(active.has("eyes")).toBe(true);
    expect(active.has(DEFAULT_EMOJIS.done)).toBe(false);
    expect(adapter.removeReaction).toHaveBeenCalledTimes(2);
    expect(adapter.removeReaction).toHaveBeenCalledWith("eyes");
    expect(adapter.removeReaction).toHaveBeenCalledWith(DEFAULT_EMOJIS.done);
    expect(adapter.removeReaction).not.toHaveBeenCalledWith(DEFAULT_EMOJIS.thinking);
  });

  it("restoreInitial still applies initial emoji when it is only debounced", async () => {
    const { adapter, active } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      emojis: { thinking: "eyes" },
      timing: { debounceMs: 20, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(1);
    expect(active.has("eyes")).toBe(true);

    void ctrl.setTool("web_search");
    await vi.advanceTimersByTimeAsync(25);
    expect(active.has(WEB_SEARCH_TOOL_EMOJI)).toBe(true);
    expect(active.has("eyes")).toBe(true);

    void ctrl.setThinking();
    await ctrl.restoreInitial();

    expect(active.has("eyes")).toBe(true);
    expect(active.has(WEB_SEARCH_TOOL_EMOJI)).toBe(false);
    expect(adapter.setReaction).toHaveBeenCalledTimes(2);
  });

  it("restoreInitial re-applies initial emoji after an in-flight debounced transition", async () => {
    let releaseThinking: (() => void) | undefined;
    const { adapter, active } = createSlackMockAdapter();
    adapter.setReaction = vi.fn(async (emoji: string) => {
      if (emoji === DEFAULT_EMOJIS.thinking) {
        await new Promise<void>((resolve) => {
          releaseThinking = resolve;
        });
      }
      if (active.has(emoji)) {
        throw new Error("already_reacted");
      }
      active.add(emoji);
    });

    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(1);
    expect(active.has("eyes")).toBe(true);

    void ctrl.setThinking();
    await vi.advanceTimersByTimeAsync(1);

    const restorePromise = ctrl.restoreInitial();
    releaseThinking?.();
    await restorePromise;

    expect(active.has("eyes")).toBe(true);
    expect(active.has(DEFAULT_EMOJIS.thinking)).toBe(false);
  });

  it("does nothing when disabled", async () => {
    const { adapter, active } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: false,
      adapter,
      initialEmoji: "eyes",
    });

    void ctrl.setQueued();
    void ctrl.setThinking();
    await ctrl.setDone();
    await vi.advanceTimersByTimeAsync(100);
    expect(active.size).toBe(0);
    expect(adapter.setReaction).not.toHaveBeenCalled();
  });

  it("coding tool resolves to coding emoji", async () => {
    const { adapter, active } = createSlackMockAdapter();
    const ctrl = createStatusReactionController({
      enabled: true,
      adapter,
      initialEmoji: "eyes",
      timing: { debounceMs: 0, stallSoftMs: 99999, stallHardMs: 99999 },
    });

    void ctrl.setQueued();
    await vi.advanceTimersByTimeAsync(10);

    void ctrl.setTool("exec");
    await vi.advanceTimersByTimeAsync(10);
    expect(active.has(EXEC_TOOL_EMOJI)).toBe(true);
    expect(active.has("eyes")).toBe(true);
  });
});
