import { render } from "lit";
import { describe, expect, it } from "vitest";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";
import { renderChatWorkingIndicator } from "./chat-working-indicator.ts";

// The picker's spec: every seeded surprise must come from this fixed rotation.
const SURPRISE_CLASSES = [
  "chat-reading-indicator--southpaw",
  "chat-reading-indicator--flurry",
  "chat-reading-indicator--spin",
  "chat-reading-indicator--shadowbox",
  "chat-reading-indicator--backflip",
  "chat-reading-indicator--zen",
  "chat-reading-indicator--drummer",
  "chat-reading-indicator--peekaboo",
  "chat-reading-indicator--nodoff",
  "chat-reading-indicator--curious",
  "chat-reading-indicator--omnom",
  "chat-reading-indicator--fakeout",
] as const;

// The keyed sample is deterministic for a fixed salt, so the rarity and spread
// assertions below are exact re-runs, not statistical flakes.
const SAMPLE_SALT = 0x5eed;
const sampleDecisions = Array.from({ length: 10_000 }, (_, index) =>
  selectWorkingClawSurprise(`run:${index}`, { salt: SAMPLE_SALT }),
);

function findSampleKey(wantSurprise: boolean): string {
  const index = sampleDecisions.findIndex((decision) => Boolean(decision) === wantSurprise);
  if (index === -1) {
    throw new Error(`no sample key with surprise=${String(wantSurprise)}`);
  }
  return `run:${index}`;
}

describe("selectWorkingClawSurprise", () => {
  it("keeps surprises rare, deterministic, and spread across every move", () => {
    const surprises = sampleDecisions.filter(Boolean);

    // ~5% target: SURPRISE_CHANCE_PER_THOUSAND=50 over 10k keys lands near 500.
    expect(surprises.length).toBeGreaterThan(400);
    expect(surprises.length).toBeLessThan(600);
    expect(selectWorkingClawSurprise("run:42", { salt: SAMPLE_SALT })).toBe(
      selectWorkingClawSurprise("run:42", { salt: SAMPLE_SALT }),
    );
    expect(new Set(surprises)).toEqual(new Set(SURPRISE_CLASSES));

    // The move pick must not reuse the rarity bits (hash % 1000); if it did,
    // some moves would cluster while others nearly vanish from the rotation.
    const counts = new Map<string, number>();
    for (const surprise of surprises) {
      counts.set(surprise, (counts.get(surprise) ?? 0) + 1);
    }
    for (const surpriseClass of SURPRISE_CLASSES) {
      expect(counts.get(surpriseClass) ?? 0).toBeGreaterThanOrEqual(10);
    }
  });

  it("keeps ineligible keys on the default claw even when they would surprise", () => {
    const surprisingKey = findSampleKey(true);
    expect(selectWorkingClawSurprise(surprisingKey, { salt: SAMPLE_SALT })).not.toBe("");
    expect(selectWorkingClawSurprise(surprisingKey, { salt: SAMPLE_SALT, eligible: false })).toBe(
      "",
    );
  });
});

describe("renderChatWorkingIndicator", () => {
  // The render path seeds with the module's per-page-load salt, so probe that
  // same default salt for keys that do (and do not) surprise this session.
  function findRenderKey(wantSurprise: boolean): string {
    for (let index = 0; index < 10_000; index++) {
      const key = `probe:${index}`;
      if (Boolean(selectWorkingClawSurprise(key)) === wantSurprise) {
        return key;
      }
    }
    throw new Error(`no render key with surprise=${String(wantSurprise)}`);
  }

  function surpriseClassesFor(key: string, waitingApproval: boolean): string[] {
    const container = document.createElement("div");
    render(
      renderChatWorkingIndicator(
        { kind: "reading-indicator", key, startedAt: 1 },
        { waitingApproval },
      ),
      container,
    );
    const bubble = container.querySelector(".chat-reading-indicator");
    expect(bubble).not.toBeNull();
    return [...(bubble?.classList ?? [])].filter((name) =>
      name.startsWith("chat-reading-indicator--"),
    );
  }

  it("routes the seeded surprise class onto the claw bubble", () => {
    const surprisingKey = findRenderKey(true);
    expect(surpriseClassesFor(surprisingKey, false)).toEqual([
      selectWorkingClawSurprise(surprisingKey),
    ]);
    expect(surpriseClassesFor(findRenderKey(false), false)).toEqual([]);
  });

  it("keeps approval waits on the default claw even for surprising keys", () => {
    expect(surpriseClassesFor(findRenderKey(true), true)).toEqual([]);
  });

  it("keeps long-wait whimsy available alongside a truthful startup phase", () => {
    const container = document.createElement("div");
    render(
      renderChatWorkingIndicator(
        { kind: "reading-indicator", key: "run:startup", startedAt: 1 },
        { startupPhase: "starting_model" },
      ),
      container,
    );

    expect(container.textContent).toContain("Waiting for a response…");
    expect(container.querySelector("openclaw-working-phrase")).not.toBeNull();
  });
});
