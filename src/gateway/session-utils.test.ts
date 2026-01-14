import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  capArrayByJsonBytes,
  classifySessionKey,
  parseGroupKey,
  resolveGatewaySessionStoreTarget,
  resolveSessionStoreKey,
} from "./session-utils.js";

describe("gateway session utils", () => {
  test("capArrayByJsonBytes trims from the front", () => {
    const res = capArrayByJsonBytes(["a", "b", "c"], 10);
    expect(res.items).toEqual(["b", "c"]);
  });

  test("parseGroupKey handles group prefixes", () => {
    expect(parseGroupKey("group:abc")).toEqual({ id: "abc" });
    expect(parseGroupKey("discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("foo:bar")).toBeNull();
  });

  test("classifySessionKey respects chat type + prefixes", () => {
    expect(classifySessionKey("global")).toBe("global");
    expect(classifySessionKey("unknown")).toBe("unknown");
    expect(classifySessionKey("group:abc")).toBe("group");
    expect(classifySessionKey("discord:group:dev")).toBe("group");
    expect(classifySessionKey("main")).toBe("direct");
    const entry = { chatType: "group" } as SessionEntry;
    expect(classifySessionKey("main", entry)).toBe("group");
  });

  test("resolveSessionStoreKey maps main aliases to default agent main", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as ClawdbotConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe(
      "agent:ops:work",
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "work" })).toBe(
      "agent:ops:work",
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:main" })).toBe(
      "agent:ops:work",
    );
  });

  test("resolveSessionStoreKey canonicalizes bare keys to default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as ClawdbotConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "group:123" })).toBe(
      "agent:ops:group:123",
    );
    expect(
      resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:main" }),
    ).toBe("agent:alpha:main");
  });

  test("resolveSessionStoreKey honors global scope", () => {
    const cfg = {
      session: { scope: "global", mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as ClawdbotConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("global");
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("global");
    expect(target.agentId).toBe("ops");
  });

  test("resolveGatewaySessionStoreTarget uses canonical key for main alias", () => {
    const storeTemplate = path.join(
      os.tmpdir(),
      "clawdbot-session-utils",
      "{agentId}",
      "sessions.json",
    );
    const cfg = {
      session: { mainKey: "main", store: storeTemplate },
      agents: { list: [{ id: "ops", default: true }] },
    } as ClawdbotConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("agent:ops:main");
    expect(target.storeKeys).toEqual(
      expect.arrayContaining(["agent:ops:main", "main"]),
    );
    expect(target.storePath).toBe(
      path.resolve(storeTemplate.replace("{agentId}", "ops")),
    );
  });
});
