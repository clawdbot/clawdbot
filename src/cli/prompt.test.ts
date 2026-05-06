import readline from "node:readline/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isYes, setVerbose, setYes } from "../globals.js";
import { PromptInputClosedError, promptYesNo } from "./prompt.js";

const readlineState = vi.hoisted(() => {
  const question = vi.fn(async () => "");
  const close = vi.fn();
  const listeners = new Map<string, Set<() => void>>();
  const once = vi.fn((event: string, listener: () => void) => {
    const current = listeners.get(event) ?? new Set<() => void>();
    current.add(listener);
    listeners.set(event, current);
  });
  const off = vi.fn((event: string, listener: () => void) => {
    listeners.get(event)?.delete(listener);
  });
  const emit = (event: string) => {
    const current = [...(listeners.get(event) ?? [])];
    listeners.delete(event);
    for (const listener of current) {
      listener();
    }
  };
  const resetListeners = () => {
    listeners.clear();
  };
  const createInterface = vi.fn(() => ({ question, close, once, off }));
  return { question, close, createInterface, emit, off, once, resetListeners };
});

vi.mock("node:readline/promises", () => ({
  default: { createInterface: readlineState.createInterface },
}));

beforeEach(() => {
  setYes(false);
  setVerbose(false);
  readlineState.question.mockReset();
  readlineState.question.mockResolvedValue("");
  readlineState.close.mockClear();
  readlineState.createInterface.mockClear();
  readlineState.off.mockClear();
  readlineState.once.mockClear();
  readlineState.resetListeners();
});

describe("promptYesNo", () => {
  it("returns true when global --yes is set", async () => {
    setYes(true);
    setVerbose(false);
    const result = await promptYesNo("Continue?");
    expect(result).toBe(true);
    expect(isYes()).toBe(true);
  });

  it("asks the question and respects default", async () => {
    setYes(false);
    setVerbose(false);
    expect(readline).toBeTruthy();
    readlineState.question.mockResolvedValueOnce("");
    const resultDefaultYes = await promptYesNo("Continue?", true);
    expect(resultDefaultYes).toBe(true);

    readlineState.question.mockResolvedValueOnce("n");
    const resultNo = await promptYesNo("Continue?", true);
    expect(resultNo).toBe(false);

    readlineState.question.mockResolvedValueOnce("y");
    const resultYes = await promptYesNo("Continue?", false);
    expect(resultYes).toBe(true);
  });

  it("rejects when input closes before an answer is received", async () => {
    readlineState.question.mockReturnValueOnce(new Promise<string>(() => undefined));

    const result = promptYesNo("Continue?");
    readlineState.emit("close");

    await expect(result).rejects.toThrow(PromptInputClosedError);
    expect(readlineState.close).toHaveBeenCalled();
  });
});
