import { describe, expect, it } from "vitest";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";

describe("resolveDiscordDmCommandAccess", () => {
  const sender = {
    id: "123",
    name: "alice",
    tag: "alice#0001",
  };

  async function resolveOpenDmAccess(configuredAllowFrom: string[]) {
    return await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom,
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });
  }

  it("blocks open DMs without allowlist wildcard entries", async () => {
    const result = await resolveOpenDmAccess([]);

    expect(result.decision).toBe("block");
    expect(result.commandAuthorized).toBe(false);
  });

  it("marks command auth true when sender is allowlisted", async () => {
    const result = await resolveOpenDmAccess(["discord:123"]);

    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
  });

  it("blocks open DMs when configured allowlist does not match", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: ["discord:999"],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("block");
    expect(result.allowMatch.allowed).toBe(false);
    expect(result.commandAuthorized).toBe(false);
  });

  it("returns pairing decision and unauthorized command auth for unknown senders", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: ["discord:456"],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("pairing");
    expect(result.commandAuthorized).toBe(false);
  });

  it("authorizes sender from pairing-store allowlist entries", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      sender,
      allowNameMatching: false,
      useAccessGroups: true,
      readStoreAllowFrom: async () => ["discord:123"],
    });

    expect(result.decision).toBe("allow");
    expect(result.commandAuthorized).toBe(true);
  });

  it("keeps open DM blocked without wildcard even when access groups are disabled", async () => {
    const result = await resolveDiscordDmCommandAccess({
      accountId: "default",
      dmPolicy: "open",
      configuredAllowFrom: [],
      sender,
      allowNameMatching: false,
      useAccessGroups: false,
      readStoreAllowFrom: async () => [],
    });

    expect(result.decision).toBe("block");
    expect(result.commandAuthorized).toBe(false);
  });
});
