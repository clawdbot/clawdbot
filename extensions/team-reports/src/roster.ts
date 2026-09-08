import type { Person, Roster } from "./types.js";

export function isBotLogin(login: string): boolean {
  return /(?:\[bot\]|bot)$/i.test(login) || /^(?:copilot|codex)$/i.test(login);
}

export function primaryLogin(person: Person): string {
  const login = person.github[0];
  if (!login) {
    throw new Error("A report identity requires at least one GitHub login");
  }
  return login.toLowerCase();
}

export function buildRoster(people: Person[], githubPeople: Person[] = []): Roster {
  const byLogin = new Map<string, Person>();
  const byDiscordId = new Map<string, Person>();
  const all: Person[] = [];
  for (const [entries, configured] of [
    [people, true],
    [githubPeople, false],
  ] as const) {
    for (const entry of entries) {
      const github = [...new Set(entry.github.map((login) => login.trim().toLowerCase()))];
      if (!github.length || github.some((login) => !login)) {
        throw new Error("A report identity requires nonempty GitHub logins");
      }
      const overlaps = new Set(
        github.map((login) => byLogin.get(login)).filter((person) => person !== undefined),
      );
      if (overlaps.size) {
        if (configured || overlaps.size > 1) {
          throw new Error(`Conflicting report identity: ${github.join(", ")}`);
        }
        // The explicit identity map owns aliases, status, and Discord attribution.
        continue;
      }
      if (github.every(isBotLogin)) {
        continue;
      }
      const person: Person = {
        ...entry,
        github,
        ...(entry.access ? { access: [...entry.access] } : {}),
        ...(entry.areas ? { areas: [...entry.areas] } : {}),
      };
      all.push(person);
      for (const login of github) {
        byLogin.set(login, person);
      }
      if (person.discordUserId) {
        if (byDiscordId.has(person.discordUserId)) {
          throw new Error(`Conflicting Discord identity for ${primaryLogin(person)}`);
        }
        byDiscordId.set(person.discordUserId, person);
      }
    }
  }
  return {
    members: all
      .filter((person) => person.status !== "archived")
      .toSorted((a, b) => primaryLogin(a).localeCompare(primaryLogin(b))),
    byLogin,
    byDiscordId,
  };
}
