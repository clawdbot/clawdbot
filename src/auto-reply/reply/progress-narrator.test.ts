// Progress narrator tests cover trigger policy, gating, and reply-option wiring.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";

const narratorWarnSpy = vi.hoisted(() => vi.fn());
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

import {
  attachProgressNarratorToReplyOptions,
  createProgressNarrator,
} from "./progress-narrator.js";

type ProgressNarrationInput = Parameters<
  NonNullable<Parameters<typeof createProgressNarrator>[0]["generate"]>
>[0];

const cfg = {} as OpenClawConfig;

// The narrator runs generations on a detached promise; drain microtasks so
// onUpdate assertions observe the settled state.
async function flushNarrations() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function createNarratorHarness(params?: {
  texts?: Array<string | null>;
  now?: () => number;
  hideCommandText?: boolean;
}) {
  const inputs: ProgressNarrationInput[] = [];
  const texts = params?.texts ?? ["Working on the request."];
  const generate = vi.fn(async (input: ProgressNarrationInput) => {
    inputs.push(input);
    return texts[Math.min(inputs.length - 1, texts.length - 1)] ?? null;
  });
  const onUpdate = vi.fn();
  const narrator = createProgressNarrator({
    cfg,
    agentId: "main",
    userMessage: "change the default model",
    onUpdate,
    generate,
    now: params?.now,
    hideCommandText: params?.hideCommandText,
  });
  return { narrator, generate, onUpdate, inputs };
}

describe("createProgressNarrator", () => {
  it("narrates after the first work tool event", async () => {
    const { narrator, generate, onUpdate, inputs } = createNarratorHarness();

    narrator.noteToolStart({ name: "exec", phase: "start", args: { command: "ls" } });
    await flushNarrations();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ text: "Working on the request." });
    expect(inputs[0]?.userMessage).toBe("change the default model");
    expect(inputs[0]?.activityNotes.join("\n")).toContain("ls");
  });

  it("ignores non-work tools and non-start phases", async () => {
    const { narrator, generate } = createNarratorHarness();

    narrator.noteToolStart({ name: "message", phase: "start" });
    narrator.noteToolStart({ name: "exec", phase: "end" });
    await flushNarrations();

    expect(generate).not.toHaveBeenCalled();
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

  it("narrates failures immediately", async () => {
    const { narrator, generate, onUpdate, inputs } = createNarratorHarness({
      texts: ["Running a command.", "The command failed, retrying."],
    });

    narrator.noteToolStart({ name: "exec", phase: "start" });
    await flushNarrations();
    narrator.noteCommandOutput({ name: "exec", title: "pnpm test", phase: "end", exitCode: 1 });
    await flushNarrations();

    expect(generate).toHaveBeenCalledTimes(2);
    expect(inputs[1]?.activityNotes.join("\n")).toContain("pnpm test failed (exit 1)");
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
    expect(notes).toContain("exec failed (exit 1)");
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
    const opts: GetReplyOptions = {
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
});
