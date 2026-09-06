import { describe, expect, it } from "vitest";
import { buildRoster } from "./roster.js";

describe("report roster", () => {
  it("unifies team membership and configured aliases while retaining archived history identities", () => {
    const roster = buildRoster(
      [
        { github: ["ALPHA", "Alpha-Work"], display: "A. Example", discordUserId: "11" },
        { github: ["Former"], status: "archived", archivedAt: "2026-08-01", discordUserId: "22" },
      ],
      [
        { github: ["alpha-work"] },
        { github: ["beta"] },
        { github: ["former"] },
        { github: ["robot"] },
      ],
    );
    expect(roster.members.map((person) => person.github[0])).toEqual(["alpha", "beta"]);
    expect(roster.byLogin.get("alpha-work")).toBe(roster.byLogin.get("alpha"));
    expect(roster.byDiscordId.get("11")?.display).toBe("A. Example");
    expect(roster.byLogin.get("former")?.status).toBe("archived");
    expect(roster.byDiscordId.get("22")?.github).toEqual(["former"]);
  });

  it("rejects ambiguous login and Discord attribution", () => {
    expect(() =>
      buildRoster([{ github: ["alpha", "shared"] }, { github: ["beta", "SHARED"] }]),
    ).toThrow("Conflicting report identity");
    expect(() =>
      buildRoster([
        { github: ["alpha"], discordUserId: "11" },
        { github: ["beta"], discordUserId: "11" },
      ]),
    ).toThrow("Conflicting Discord identity");
  });
});
