import { describe, expect, it } from "vitest";
import type { AgentsListResult, GatewaySessionRow } from "../../api/types.ts";
import { agentRosterCards } from "./roster-activity.ts";

describe("agent roster activity", () => {
  it("aggregates work across sessions while keeping the main preview and identity", () => {
    const roster: AgentsListResult = {
      defaultId: "harbor",
      mainKey: "team",
      scope: "per-sender",
      agents: [
        { id: "harbor" },
        { id: "ember" },
        { id: "empty" },
        { id: "system", kind: "system" },
      ],
    };
    const rows: GatewaySessionRow[] = [
      {
        key: "agent:harbor:other",
        kind: "direct",
        updatedAt: 9,
        lastMessagePreview: "Recent fallback",
      },
      { key: "agent:ember:team", kind: "direct", updatedAt: 1, lastMessagePreview: "Main summary" },
      {
        key: "agent:ember:work",
        kind: "direct",
        updatedAt: 4,
        hasActiveRun: true,
        lastMessagePreview: "Side task",
      },
      { key: "foreign-key", agentId: "ember", kind: "direct", updatedAt: 6 },
    ];
    const cards = agentRosterCards(roster, rows, (id) =>
      id === "ember" ? { agentId: id, name: "Ember", emoji: "🔥", avatar: "" } : null,
    );
    expect(cards.map((card) => card.id)).toEqual(["ember", "harbor", "empty"]);
    expect(cards[0]).toMatchObject({
      name: "Ember",
      fallback: "🔥",
      activeNow: true,
      lastActiveAt: 6,
      preview: "Main summary",
      mainKey: "agent:ember:team",
    });
    expect(cards[1]).toMatchObject({
      activeNow: false,
      lastActiveAt: 9,
      preview: "Recent fallback",
    });
    expect(cards[2]).toMatchObject({ activeNow: false, lastActiveAt: 0, preview: undefined });
  });

  it("honors terminal run state and uses the main flag when its canonical key is absent", () => {
    const roster: AgentsListResult = {
      defaultId: "beta",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "alpha" }, { id: "beta" }],
    };
    const cards = agentRosterCards(roster, [
      { key: "agent:alpha:old", kind: "direct", updatedAt: 2, hasActiveRun: true, status: "done" },
      {
        key: "agent:beta:main-alias",
        kind: "direct",
        isMain: true,
        lastMessagePreview: "Flagged main",
      },
      { key: "agent:beta:recent", kind: "direct", updatedAt: 2, lastMessagePreview: "Other" },
    ]);
    expect(cards.map((card) => card.id)).toEqual(["beta", "alpha"]);
    expect(cards.every((card) => !card.activeNow)).toBe(true);
    expect(cards[0]?.preview).toBe("Flagged main");
  });
});
