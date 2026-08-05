// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./working-phrase.ts";

// Mirrors WORKING_PHRASE_SHOW_AFTER_MS / WORKING_PHRASE_ROTATE_EVERY_MS in
// working-phrase.ts (knip forbids test-only exports).
const WORKING_PHRASE_SHOW_AFTER_MS = 30_000;
const WORKING_PHRASE_ROTATE_EVERY_MS = 45_000;

type WorkingPhraseElement = HTMLElement & {
  startMs: number | null;
  seed: string;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
};

const NOW = 2_000_000_000;
// "· Clawing…" — a middot, one gerund, an ellipsis.
const PHRASE_TEXT = /^·\s\S+…$/;

function mountPhrase(seed = "stream-working:test"): WorkingPhraseElement {
  const element = document.createElement("openclaw-working-phrase") as WorkingPhraseElement;
  element.seed = seed;
  element.startMs = NOW;
  document.body.appendChild(element);
  return element;
}

async function textAt(element: WorkingPhraseElement, elapsedMs: number): Promise<string> {
  vi.setSystemTime(NOW + elapsedMs);
  element.requestUpdate();
  await element.updateComplete;
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

describe("openclaw-working-phrase", () => {
  let element: WorkingPhraseElement;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    element = mountPhrase();
  });

  afterEach(() => {
    element.remove();
    vi.useRealTimers();
  });

  it("stays silent before the quiet threshold", async () => {
    expect(await textAt(element, WORKING_PHRASE_SHOW_AFTER_MS - 5_000)).toBe("");
  });

  it("shows a phrase once the wait drags on", async () => {
    expect(await textAt(element, WORKING_PHRASE_SHOW_AFTER_MS + 1_000)).toMatch(PHRASE_TEXT);
  });

  it("is stable within a rotation and changes across rotations", async () => {
    const first = await textAt(element, WORKING_PHRASE_SHOW_AFTER_MS + 1_000);
    const stillFirst = await textAt(element, WORKING_PHRASE_SHOW_AFTER_MS + 10_000);
    expect(stillFirst).toBe(first);

    // Adjacent rotations must differ even when raw hashes collide, across
    // many buckets (the displayed word feeds the next bucket's dodge).
    let previous = first;
    for (let bucket = 1; bucket <= 8; bucket++) {
      const next = await textAt(
        element,
        WORKING_PHRASE_SHOW_AFTER_MS + bucket * WORKING_PHRASE_ROTATE_EVERY_MS + 1_000,
      );
      expect(next).toMatch(PHRASE_TEXT);
      expect(next).not.toBe(previous);
      previous = next;
    }
  });

  it("is deterministic per seed", async () => {
    const twin = mountPhrase();
    try {
      const a = await textAt(element, WORKING_PHRASE_SHOW_AFTER_MS + 1_000);
      const b = await textAt(twin, WORKING_PHRASE_SHOW_AFTER_MS + 1_000);
      expect(b).toBe(a);
    } finally {
      twin.remove();
    }
  });
});
