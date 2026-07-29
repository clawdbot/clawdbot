/**
 * Session key write/read round-trip tests.
 *
 * Validates that the write-path canonicalization fix (#29683) produces keys
 * that match what all read paths expect, preventing orphaned sessions.
 *
 * The critical mismatch: `resolveSessionKey` hardcodes DEFAULT_AGENT_ID="main",
 * producing keys like "agent:main:work". But the gateway's canonical read path
 * (`resolveMainSessionKey(cfg)`) uses the configured agent, producing
 * "agent:ops:work". Without canonicalization, writes and reads diverge.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionKey } from "../config/sessions/session-key.js";
import { resolveCronAgentSessionKey } from "../cron/isolated-agent/session-key.js";
import { resolveSessionStoreKey } from "../gateway/session-store-key.js";
import { normalizeMainKey } from "../routing/session-key.js";

function makeNonDefaultAgentCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    session: { mainKey: "work", scope: "per-sender" },
    agents: { list: [{ id: "ops", default: true }] },
    ...overrides,
  } as OpenClawConfig;
}

describe("session key write/read round-trip (#29683)", () => {
  describe("initSessionState write path consistency", () => {
    it("write path key matches resolveSessionStoreKey read-back", () => {
      const cfg = makeNonDefaultAgentCfg();
      const agentId = "ops";
      const mainKey = normalizeMainKey(cfg.session?.mainKey);

      // Write path: resolveSessionKey + canonicalize (as in initSessionState)
      const rawWriteKey = resolveSessionKey(
        "per-sender",
        { From: "+1234567890" },
        mainKey,
        agentId,
      );
      const writeKey = canonicalizeMainSessionAlias({
        cfg,
        agentId,
        sessionKey: rawWriteKey,
      });

      // Re-read path: resolveSessionStoreKey (used by loadSessionEntry)
      const readKey = resolveSessionStoreKey({ cfg, sessionKey: writeKey });

      // The write key and read-back key must match
      expect(writeKey).toBe(readKey);
    });

    it("write path key matches gateway canonical main session key", () => {
      const cfg = makeNonDefaultAgentCfg();
      const agentId = "ops";
      const mainKey = normalizeMainKey(cfg.session?.mainKey);

      const rawWriteKey = resolveSessionKey(
        "per-sender",
        { From: "+1234567890" },
        mainKey,
        agentId,
      );
      const writeKey = canonicalizeMainSessionAlias({
        cfg,
        agentId,
        sessionKey: rawWriteKey,
      });

      // Gateway canonical key: resolveMainSessionKey uses configured agent
      const gatewayCanonicalKey = resolveMainSessionKey(cfg);

      // CRITICAL: these must match for the session to survive gateway restarts.
      // resolveMainSessionKey produces "agent:ops:work" while the uncanonicalized
      // write path produces "agent:main:work". canonicalizeMainSessionAlias must
      // bridge this gap.
      expect(writeKey).toBe(gatewayCanonicalKey);
    });
  });

  describe("cron write path round-trip", () => {
    it("cron session key matches gateway canonical main session key", () => {
      const cfg = makeNonDefaultAgentCfg();

      const writeKey = resolveCronAgentSessionKey({
        sessionKey: "main",
        agentId: "ops",
        mainKey: "work",
        cfg,
      });

      const gatewayCanonicalKey = resolveMainSessionKey(cfg);

      expect(writeKey).toBe(gatewayCanonicalKey);
      expect(writeKey).toBe("agent:ops:work");
    });
  });

  describe("group session keys are unaffected", () => {
    it("group keys bypass main-alias canonicalization", () => {
      const cfg = makeNonDefaultAgentCfg();
      const agentId = "ops";
      const mainKey = normalizeMainKey(cfg.session?.mainKey);

      const rawWriteKey = resolveSessionKey(
        "per-sender",
        { From: "group:discord:group:123456789" },
        mainKey,
        agentId,
      );
      const writeKey = canonicalizeMainSessionAlias({
        cfg,
        agentId,
        sessionKey: rawWriteKey,
      });

      const readKey = resolveSessionStoreKey({ cfg, sessionKey: writeKey });

      // Group keys contain channel-scoped identifiers and are not main aliases,
      // so they round-trip correctly regardless of agent config.
      expect(writeKey).toBe(readKey);
    });
  });

  describe("no-op when default agent is main", () => {
    it("write and gateway canonical keys match when agent is main", () => {
      const cfg = {
        agents: { entries: { main: { default: true } } },
        session: { scope: "per-sender" },
      } as OpenClawConfig;
      const mainKey = normalizeMainKey(cfg.session?.mainKey);

      const rawWriteKey = resolveSessionKey("per-sender", { From: "+1234567890" }, mainKey, "main");
      const writeKey = canonicalizeMainSessionAlias({
        cfg,
        agentId: "main",
        sessionKey: rawWriteKey,
      });

      const gatewayCanonicalKey = resolveMainSessionKey(cfg);

      expect(writeKey).toBe(gatewayCanonicalKey);
      expect(writeKey).toBe("agent:main:main");
    });
  });
});
