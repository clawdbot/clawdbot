import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { MoltbotConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  capArrayByJsonBytes,
  classifySessionKey,
  deriveSessionTitle,
  listSessionsFromStore,
  parseGroupKey,
  resolveGatewaySessionStoreTarget,
  resolveSessionStoreKey,
} from "./session-utils.js";

describe("gateway session utils", () => {
  test("capArrayByJsonBytes trims from the front", () => {
    const res = capArrayByJsonBytes(["a", "b", "c"], 10);
    expect(res.items).toEqual(["b", "c"]);
  });

  test("parseGroupKey handles group keys", () => {
    expect(parseGroupKey("discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("agent:ops:discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("foo:bar")).toBeNull();
  });

  test("classifySessionKey respects chat type + prefixes", () => {
    expect(classifySessionKey("global")).toBe("global");
    expect(classifySessionKey("unknown")).toBe("unknown");
    expect(classifySessionKey("discord:group:dev")).toBe("group");
    expect(classifySessionKey("main")).toBe("direct");
    const entry = { chatType: "group" } as SessionEntry;
    expect(classifySessionKey("main", entry)).toBe("group");
  });

  test("resolveSessionStoreKey maps main aliases to default agent main", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as MoltbotConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "work" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:main" })).toBe("agent:ops:work");
  });

  test("resolveSessionStoreKey canonicalizes bare keys to default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as MoltbotConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:main" })).toBe(
      "agent:alpha:main",
    );
  });

  test("resolveSessionStoreKey honors global scope", () => {
    const cfg = {
      session: { scope: "global", mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as MoltbotConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("global");
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("global");
    expect(target.agentId).toBe("ops");
  });

  test("resolveGatewaySessionStoreTarget uses canonical key for main alias", () => {
    const storeTemplate = path.join(
      os.tmpdir(),
      "moltbot-session-utils",
      "{agentId}",
      "sessions.json",
    );
    const cfg = {
      session: { mainKey: "main", store: storeTemplate },
      agents: { list: [{ id: "ops", default: true }] },
    } as MoltbotConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("agent:ops:main");
    expect(target.storeKeys).toEqual(expect.arrayContaining(["agent:ops:main", "main"]));
    expect(target.storePath).toBe(path.resolve(storeTemplate.replace("{agentId}", "ops")));
  });
});

describe("deriveSessionTitle", () => {
  test("returns undefined for undefined entry", () => {
    expect(deriveSessionTitle(undefined)).toBeUndefined();
  });

  test("prefers displayName when set", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "My Custom Session",
      subject: "Group Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("My Custom Session");
  });

  test("falls back to subject when displayName is missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      subject: "Dev Team Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Dev Team Chat");
  });

  test("uses first user message when displayName and subject missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry, "Hello, how are you?")).toBe("Hello, how are you?");
  });

  test("truncates long first user message to 60 chars with ellipsis", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg =
      "This is a very long message that exceeds sixty characters and should be truncated appropriately";
    const result = deriveSessionTitle(entry, longMsg);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(60);
    expect(result!.endsWith("…")).toBe(true);
  });

  test("truncates at word boundary when possible", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg = "This message has many words and should be truncated at a word boundary nicely";
    const result = deriveSessionTitle(entry, longMsg);
    expect(result).toBeDefined();
    expect(result!.endsWith("…")).toBe(true);
    expect(result!.includes("  ")).toBe(false);
  });

  test("falls back to sessionId prefix with date", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: new Date("2024-03-15T10:30:00Z").getTime(),
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234 (2024-03-15)");
  });

  test("falls back to sessionId prefix without date when updatedAt missing", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: 0,
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234");
  });

  test("trims whitespace from displayName", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "  Padded Name  ",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Padded Name");
  });

  test("ignores empty displayName and falls through", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "   ",
      subject: "Actual Subject",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Actual Subject");
  });
});

describe("listSessionsFromStore search", () => {
  const baseCfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as MoltbotConfig;

  const makeStore = (): Record<string, SessionEntry> => ({
    "agent:main:work-project": {
      sessionId: "sess-work-1",
      updatedAt: Date.now(),
      displayName: "Work Project Alpha",
      label: "work",
    } as SessionEntry,
    "agent:main:personal-chat": {
      sessionId: "sess-personal-1",
      updatedAt: Date.now() - 1000,
      displayName: "Personal Chat",
      subject: "Family Reunion Planning",
    } as SessionEntry,
    "agent:main:discord:group:dev-team": {
      sessionId: "sess-discord-1",
      updatedAt: Date.now() - 2000,
      label: "discord",
      subject: "Dev Team Discussion",
    } as SessionEntry,
  });

  test("returns all sessions when search is empty", () => {
    const store = makeStore();
    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: { search: "" },
    });
    expect(result.sessions.length).toBe(3);
  });

  test("returns all sessions when search is undefined", () => {
    const store = makeStore();
    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    expect(result.sessions.length).toBe(3);
  });

  test("filters by displayName case-insensitively", () => {
    const store = makeStore();
    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: { search: "WORK PROJECT" },
    });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].displayName).toBe("Work Project Alpha");
  });

  test("filters by subject", () => {
    const store = makeStore();
    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: { search: "reunion" },
    });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].subject).toBe("Family Reunion Planning");
  });

  test("filters by label", () => {
    const store = makeStore();
    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: { search: "discord" },
    });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].label).toBe("discord");
  });

  test("filters by sessionId", () => {
    const store = makeStore();
    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: { search: "sess-personal" },
    });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].sessionId).toBe("sess-personal-1");
  });

  test("filters by key", () => {
    const store = makeStore();
    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: { search: "dev-team" },
    });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].key).toBe("agent:main:discord:group:dev-team");
  });

  test("returns empty array when no matches", () => {
    const store = makeStore();
    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: { search: "nonexistent-term" },
    });
    expect(result.sessions.length).toBe(0);
  });

  test("matches partial strings", () => {
    const store = makeStore();
    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: { search: "alpha" },
    });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].displayName).toBe("Work Project Alpha");
  });

  test("trims whitespace from search query", () => {
    const store = makeStore();
    const result = listSessionsFromStore({
      cfg: baseCfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: { search: "  personal  " },
    });
    expect(result.sessions.length).toBe(1);
  });
});
