// Session store target resolution for the per-agent deterministic store hot path.
import nodeFs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { resolveExistingAgentSessionStoreTargetsSync } from "./targets.js";
import { createAgentSessionStores, createCustomRootCfg } from "./targets.test-support.js";

describe("resolveExistingAgentSessionStoreTargetsSync deterministic store", () => {
  it("does not touch other agents' store files when the deterministic store exists", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const storePaths = await createAgentSessionStores(stateDir, ["ops", "retired"]);
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
      };
      const readdirSpy = vi.spyOn(nodeFs, "readdirSync");
      const lstatSpy = vi.spyOn(nodeFs, "lstatSync");
      const realpathSpy = vi.spyOn(nodeFs.realpathSync, "native");

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", { env: process.env })).toEqual(
        [{ agentId: "ops", storePath: storePaths.ops }],
      );
      // Discovery stays agent-scoped: the agents root is listed, but no retired agent
      // store file is ever statted or realpathed on the hot path.
      expect(readdirSpy).toHaveBeenCalledTimes(1);
      expect(readdirSpy.mock.calls[0]![0]).toBe(path.join(stateDir, "agents"));
      const touched = [...lstatSpy.mock.calls, ...realpathSpy.mock.calls]
        .map(([firstArg]) => (typeof firstArg === "string" ? firstArg : ""))
        .filter((candidate) => candidate.includes("retired"));
      expect(touched).toEqual([]);
      readdirSpy.mockRestore();
      lstatSpy.mockRestore();
      realpathSpy.mockRestore();
    });
  });

  it("falls back to directory discovery when the deterministic store is missing", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const storePaths = await createAgentSessionStores(stateDir, ["ops"]);
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
        session: {
          store: path.join(home, "external", "sessions-{agentId}.json"),
        },
      };

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", { env: process.env })).toEqual(
        [{ agentId: "ops", storePath: storePaths.ops }],
      );
    });
  });

  it("keeps an alternate same-agent store in another root visible when the deterministic store exists", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const customRoot = path.join(home, "custom-state");
      const customStorePaths = await createAgentSessionStores(customRoot, ["ops"]);
      const defaultStorePaths = await createAgentSessionStores(stateDir, ["ops"]);
      const cfg = createCustomRootCfg(customRoot);

      const targets = resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", {
        env: process.env,
      });

      expect(targets.map((target) => target.storePath).toSorted()).toEqual(
        [customStorePaths.ops!, defaultStorePaths.ops!].toSorted(),
      );
    });
  });

  it("keeps a non-round-tripping same-agent store visible when the deterministic store exists", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const storePaths = await createAgentSessionStores(stateDir, ["ops"]);
      const aliasStorePaths = await createAgentSessionStores(stateDir, ["Ops"]);
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
      };

      const targets = resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", {
        env: process.env,
      });

      expect(targets.map((target) => target.storePath).toSorted()).toEqual(
        [storePaths.ops!, aliasStorePaths.Ops!].toSorted(),
      );
    });
  });

  it("keeps a same-agent store visible under another configured agent's template root", async () => {
    // A template may carry {agentId} before the final agents/<agentId> segment. Each configured
    // agent expansion then resolves a distinct agents root, and an alternate same-agent store may
    // live under another agent's root (e.g. the ops store under the work expansion). Roots must be
    // derived from every configured expansion, not just the requested agent, or that store is lost.
    await withTempHome(async (home) => {
      const storesRoot = path.join(home, "stores");
      const cfg: OpenClawConfig = {
        session: {
          store: path.join(
            storesRoot,
            "{agentId}",
            "agents",
            "{agentId}",
            "sessions",
            "sessions.json",
          ),
        },
        agents: { list: [{ id: "ops", default: true }, { id: "work" }] },
      };
      // Deterministic ops store under the ops expansion.
      const deterministicStorePath = path.join(
        storesRoot,
        "ops",
        "agents",
        "ops",
        "sessions",
        "sessions.json",
      );
      // Alternate ops store under the work expansion — only visible if the work root is enumerated.
      const alternateStorePath = path.join(
        storesRoot,
        "work",
        "agents",
        "ops",
        "sessions",
        "sessions.json",
      );
      await replaceSessionEntry(
        { storePath: deterministicStorePath, sessionKey: "main" },
        { sessionId: "sid-deterministic", updatedAt: 1 },
      );
      await replaceSessionEntry(
        { storePath: alternateStorePath, sessionKey: "main" },
        { sessionId: "sid-alternate", updatedAt: 2 },
      );

      const targets = resolveExistingAgentSessionStoreTargetsSync(cfg, "ops", {
        env: process.env,
      });

      expect(targets.map((target) => target.storePath).toSorted()).toEqual(
        [path.resolve(deterministicStorePath), path.resolve(alternateStorePath)].toSorted(),
      );
    });
  });
});
