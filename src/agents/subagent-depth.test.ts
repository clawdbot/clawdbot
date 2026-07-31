// Subagent depth tests cover depth recovery from persisted session metadata and
// timer-safe timeout normalization for spawned agent runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

describe("getSubagentDepthFromSessionStore", () => {
  it("uses spawnDepth from the session store when available", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: { spawnDepth: 2 },
      },
    });
    expect(depth).toBe(2);
  });

  it("normalizes signed decimal stored spawnDepth strings", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: { spawnDepth: "+02" },
      },
    });
    expect(depth).toBe(2);
  });

  it("ignores non-decimal and unsafe stored spawnDepth strings", () => {
    const key = "agent:main:subagent:flat";
    for (const spawnDepth of ["1e3", "0x10", "1.5", "9007199254740993"]) {
      const depth = getSubagentDepthFromSessionStore(key, {
        store: {
          [key]: { spawnDepth },
        },
      });
      expect(depth).toBe(1);
    }
  });

  it("derives depth from spawnedBy ancestry when spawnDepth is missing", () => {
    // Ancestry fallback keeps restored sessions useful when old stores predate
    // the explicit spawnDepth field.
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionStore(key3, {
      store: {
        [key1]: { spawnedBy: "agent:main:main" },
        [key2]: { spawnedBy: key1 },
        [key3]: { spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("ignores parentSessionKey threading when resolving spawn depth", () => {
    // parentSessionKey is UI threading (dashboard auto-parenting, forks); only
    // stored spawnDepth and spawnedBy lineage may contribute depth.
    const store = {
      "agent:main:main": { sessionId: "root" },
      "agent:main:dashboard:operator": {
        sessionId: "operator",
        spawnDepth: 0,
        parentSessionKey: "agent:main:main",
      },
      "agent:main:dashboard:legacy": {
        sessionId: "legacy",
        parentSessionKey: "agent:main:main",
      },
    };
    expect(getSubagentDepthFromSessionStore("agent:main:dashboard:operator", { store })).toBe(0);
    expect(getSubagentDepthFromSessionStore("agent:main:dashboard:legacy", { store })).toBe(0);
  });

  it("resolves depth when caller is identified by sessionId", () => {
    const key1 = "agent:main:subagent:one";
    const key2 = "agent:main:subagent:two";
    const key3 = "agent:main:subagent:three";
    const depth = getSubagentDepthFromSessionStore("subagent-three-session", {
      store: {
        [key1]: { sessionId: "subagent-one-session", spawnedBy: "agent:main:main" },
        [key2]: { sessionId: "subagent-two-session", spawnedBy: key1 },
        [key3]: { sessionId: "subagent-three-session", spawnedBy: key2 },
      },
    });
    expect(depth).toBe(3);
  });

  it("resolves prefixed store keys when caller key omits the agent prefix", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-depth-"));
    const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
    const prefixedKey = "agent:main:subagent:flat";
    const storePath = storeTemplate.replaceAll("{agentId}", "main");
    await replaceSessionEntry(
      {
        storePath,
        sessionKey: prefixedKey,
      },
      {
        sessionId: "subagent-flat",
        updatedAt: Date.now(),
        spawnDepth: 2,
      },
    );

    const depth = getSubagentDepthFromSessionStore("subagent:flat", {
      cfg: {
        session: {
          store: storeTemplate,
        },
      },
    });

    expect(depth).toBe(2);
  });

  it("resolves a cross-agent parent outside the supplied child store", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-depth-cross-agent-"));
    try {
      const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
      const parentKey = "agent:main:dashboard:parent";
      await replaceSessionEntry(
        {
          agentId: "main",
          storePath: storeTemplate.replaceAll("{agentId}", "main"),
          sessionKey: parentKey,
        },
        {
          sessionId: "parent",
          updatedAt: Date.now(),
          spawnDepth: 2,
        },
      );

      const depth = getSubagentDepthFromSessionStore("agent:work:dashboard:child", {
        cfg: { session: { store: storeTemplate } },
        store: {
          "agent:work:dashboard:child": {
            sessionId: "child",
            spawnedBy: parentKey,
          },
        },
      });

      expect(depth).toBe(3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to session-key segment counting when metadata is missing", () => {
    const key = "agent:main:subagent:flat";
    const depth = getSubagentDepthFromSessionStore(key, {
      store: {
        [key]: {},
      },
    });
    expect(depth).toBe(1);
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("defaults to 48 hours when config does not override the timeout", () => {
    expect(resolveAgentTimeoutMs({})).toBe(48 * 60 * 60 * 1000);
  });

  it.each([
    ["unlimited", 0, MAX_TIMER_TIMEOUT_MS],
    ["finite", 30, 30_000],
    ["negative", -1, 1_000],
    ["NaN", Number.NaN, 48 * 60 * 60 * 1000],
  ])("resolves config timeoutSeconds %s", (_label, timeoutSeconds, expected) => {
    const cfg = { agents: { defaults: { timeoutSeconds } } } as OpenClawConfig;
    expect(resolveAgentTimeoutMs({ cfg })).toBe(expected);
  });

  it("uses a timer-safe sentinel for no-timeout overrides", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("clamps very large timeout overrides to timer-safe values", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 9_999_999 })).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ overrideMs: 9_999_999_999 })).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
