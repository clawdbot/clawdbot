// Covers usage-cost discovery honoring a configured session.store.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { discoverAllSessions, loadCostUsageSummaryFromCache } from "./session-cost-usage.js";

describe("usage cost discovery with a configured session store", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-configured-store-usage-",
  });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  const writeUsageTurn = async (params: {
    agentId: string;
    sessionId: string;
    storePath?: string;
    timestampMs: number;
    usage?: { totalTokens: number; cost: number };
  }): Promise<void> => {
    const totalTokens = params.usage?.totalTokens ?? 18;
    const cost = params.usage?.cost ?? 0.018;
    const sessionKey = `agent:${params.agentId}:${params.agentId}`;
    const scope = params.storePath ? { sessionKey, storePath: params.storePath } : { sessionKey };
    await upsertSessionEntry(scope, {
      sessionId: params.sessionId,
      updatedAt: params.timestampMs,
    });
    await persistSessionTranscriptTurn(
      {
        agentId: params.agentId,
        sessionId: params.sessionId,
        sessionKey,
        ...(params.storePath ? { storePath: params.storePath } : {}),
      },
      {
        messages: [
          { message: { role: "user", content: "usage prompt", timestamp: params.timestampMs } },
          {
            message: {
              role: "assistant",
              content: "usage answer",
              model: "gpt-5.4",
              provider: "openai",
              timestamp: params.timestampMs + 1000,
              usage: {
                input: Math.floor(totalTokens / 2),
                output: totalTokens - Math.floor(totalTokens / 2),
                totalTokens,
                cost: { total: cost },
              },
            },
          },
        ],
        touchSessionEntry: false,
      },
    );
  };

  it("aggregates sessions written to a store with a custom filename", async () => {
    const root = await suiteRootTracker.make("custom-store");
    const agentId = "main";
    const sessionId = "custom-store-session";
    // A custom basename is what makes the SQLite target diverge: the store
    // resolves to <basename>.sqlite instead of the default agent database.
    const store = path.join(root, "custom", "my-store.json");
    const config = { session: { store } } as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const storePath = resolveStorePath(store, { agentId });
      expect(storePath).toBe(store);
      await writeUsageTurn({ agentId, sessionId, storePath, timestampMs: now });

      const summary = await loadCostUsageSummaryFromCache({
        agentId,
        config,
        startMs: now - 3_600_000,
        endMs: now + 3_600_000,
        refreshMode: "sync-when-empty",
      });
      expect(summary.totals.totalTokens).toBe(18);
      expect(summary.totals.totalCost).toBeCloseTo(0.018, 8);

      const discovered = await discoverAllSessions({ agentId, config });
      expect(discovered.map((session) => session.sessionId)).toEqual([sessionId]);
    });
  });

  it("attributes sessions per agent when the configured store is a shared SQLite locator", async () => {
    const root = await suiteRootTracker.make("shared-store");
    // An exact .sqlite locator is a shared store: every agent's rows live in one
    // file, partitioned by scoped session key.
    const store = path.join(root, "shared", "team.sqlite");
    const config = { session: { store } } as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      for (const [agentId, sessionId, tokens, cost] of [
        ["alpha", "alpha-session", 18, 0.018],
        ["beta", "beta-session", 40, 0.04],
      ] as const) {
        await writeUsageTurn({
          agentId,
          sessionId,
          storePath: resolveStorePath(store, { agentId }),
          timestampMs: now,
          usage: { totalTokens: tokens, cost },
        });
      }

      for (const [agentId, sessionId, tokens, cost] of [
        ["alpha", "alpha-session", 18, 0.018],
        ["beta", "beta-session", 40, 0.04],
      ] as const) {
        const discovered = await discoverAllSessions({ agentId, config });
        expect(discovered.map((session) => session.sessionId)).toEqual([sessionId]);

        const summary = await loadCostUsageSummaryFromCache({
          agentId,
          config,
          startMs: now - 3_600_000,
          endMs: now + 3_600_000,
          refreshMode: "sync-when-empty",
        });
        expect(summary.totals.totalTokens).toBe(tokens);
        expect(summary.totals.totalCost).toBeCloseTo(cost, 8);
      }
    });
  });

  it("counts a globally scoped shared-store session once, under the default agent", async () => {
    const root = await suiteRootTracker.make("global-scope");
    const store = path.join(root, "shared", "team.sqlite");
    // A "global" session key has no agent of its own, so without an owner rule
    // every agent would claim it and the all-agent rollup would re-count it.
    const config = {
      agents: { entries: { alpha: { default: true }, beta: {} } },
      session: { scope: "global", store },
    } as unknown as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const storePath = resolveStorePath(store, { agentId: "alpha" });
      await upsertSessionEntry(
        { agentId: "alpha", sessionKey: "global", storePath },
        { sessionId: "global-session", updatedAt: now },
      );
      await persistSessionTranscriptTurn(
        { agentId: "alpha", sessionId: "global-session", sessionKey: "global", storePath },
        {
          messages: [
            { message: { role: "user", content: "usage prompt", timestamp: now } },
            {
              message: {
                role: "assistant",
                content: "usage answer",
                model: "gpt-5.4",
                provider: "openai",
                timestamp: now + 1000,
                usage: { input: 9, output: 9, totalTokens: 18, cost: { total: 0.018 } },
              },
            },
          ],
          touchSessionEntry: false,
        },
      );

      const totals: number[] = [];
      for (const agentId of ["alpha", "beta"]) {
        const summary = await loadCostUsageSummaryFromCache({
          agentId,
          config,
          startMs: now - 3_600_000,
          endMs: now + 3_600_000,
          refreshMode: "sync-when-empty",
        });
        totals.push(summary.totals.totalTokens);
      }
      // Default agent claims it; the other sees nothing, so the sum is not doubled.
      expect(totals).toEqual([18, 0]);
    });
  });

  it("treats an {agentId}-templated store as per-agent, not shared", async () => {
    const root = await suiteRootTracker.make("templated-store");
    // The template expands to a custom .sqlite filename per agent, so each agent's
    // own globally scoped session must stay visible to it.
    const store = path.join(root, "stores", "{agentId}", "agent.sqlite");
    const config = {
      agents: { entries: { alpha: { default: true }, beta: {} } },
      session: { scope: "global", store },
    } as unknown as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      for (const [agentId, tokens, cost] of [
        ["alpha", 18, 0.018],
        ["beta", 40, 0.04],
      ] as const) {
        const storePath = resolveStorePath(store, { agentId });
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        await upsertSessionEntry(
          { agentId, sessionKey: "global", storePath },
          { sessionId: `${agentId}-global`, updatedAt: now },
        );
        await persistSessionTranscriptTurn(
          { agentId, sessionId: `${agentId}-global`, sessionKey: "global", storePath },
          {
            messages: [
              { message: { role: "user", content: "usage prompt", timestamp: now } },
              {
                message: {
                  role: "assistant",
                  content: "usage answer",
                  model: "gpt-5.4",
                  provider: "openai",
                  timestamp: now + 1000,
                  usage: {
                    input: tokens / 2,
                    output: tokens / 2,
                    totalTokens: tokens,
                    cost: { total: cost },
                  },
                },
              },
            ],
            touchSessionEntry: false,
          },
        );
      }

      const totals: number[] = [];
      for (const agentId of ["alpha", "beta"]) {
        const summary = await loadCostUsageSummaryFromCache({
          agentId,
          config,
          startMs: now - 3_600_000,
          endMs: now + 3_600_000,
          refreshMode: "sync-when-empty",
        });
        totals.push(summary.totals.totalTokens);
      }
      expect(totals).toEqual([18, 40]);
    });
  });

  it("charges no agent for a legacy transcript in a directory several agents share", async () => {
    const root = await suiteRootTracker.make("shared-legacy-jsonl");
    const store = path.join(root, "shared", "team-store.json");
    const config = {
      agents: { entries: { alpha: { default: true }, beta: {} } },
      session: { store },
    } as unknown as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      // A pre-migration JSONL transcript: its filename carries no agent id, and more than
      // one agent shares this directory, so no owner is recoverable and no agent may be
      // charged for it. On main it is discovered by nobody either.
      await fs.mkdir(path.dirname(store), { recursive: true });
      await fs.writeFile(
        path.join(path.dirname(store), "legacy-session.jsonl"),
        [
          JSON.stringify({ type: "session", version: 1, id: "legacy-session" }),
          JSON.stringify({
            type: "message",
            timestamp: new Date(now).toISOString(),
            message: {
              role: "assistant",
              model: "gpt-5.4",
              provider: "openai",
              usage: { input: 50, output: 50, totalTokens: 100, cost: { total: 0.1 } },
            },
          }),
          "",
        ].join("\n"),
        "utf-8",
      );

      const totals: number[] = [];
      for (const agentId of ["alpha", "beta"]) {
        const summary = await loadCostUsageSummaryFromCache({
          agentId,
          config,
          startMs: now - 3_600_000,
          endMs: now + 3_600_000,
          refreshMode: "sync-when-empty",
        });
        totals.push(summary.totals.totalTokens);
      }
      expect(totals).toEqual([0, 0]);
    });
  });

  it("still counts a legacy transcript when one agent owns the store directory", async () => {
    const root = await suiteRootTracker.make("sole-agent-legacy-jsonl");
    const store = path.join(root, "solo", "my-store.json");
    // One configured agent: the directory cannot be ambiguous, so omitting its legacy
    // transcripts would lose usage rather than protect anyone from being mischarged.
    const config = {
      agents: { entries: { main: { default: true } } },
      session: { store },
    } as unknown as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      await fs.mkdir(path.dirname(store), { recursive: true });
      await fs.writeFile(
        path.join(path.dirname(store), "solo-session.jsonl"),
        [
          JSON.stringify({ type: "session", version: 1, id: "solo-session" }),
          JSON.stringify({
            type: "message",
            timestamp: new Date(now).toISOString(),
            message: {
              role: "assistant",
              model: "gpt-5.4",
              provider: "openai",
              usage: { input: 50, output: 50, totalTokens: 100, cost: { total: 0.1 } },
            },
          }),
          "",
        ].join("\n"),
        "utf-8",
      );

      const summary = await loadCostUsageSummaryFromCache({
        agentId: "main",
        config,
        startMs: now - 3_600_000,
        endMs: now + 3_600_000,
        refreshMode: "sync-when-empty",
      });
      expect(summary.totals.totalTokens).toBe(100);
    });
  });

  it("counts legacy transcripts for the agent a canonical store path names", async () => {
    const root = await suiteRootTracker.make("owned-legacy-jsonl");
    const stateDir = path.join(root, "state");
    // `agents/<id>/sessions/sessions.json` names its owner in the path, which is
    // authoritative even with several agents configured -- skipping it would silently
    // undercount that agent's history.
    const store = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const config = {
      agents: { entries: { main: { default: true }, beta: {} } },
      session: { store },
    } as unknown as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await fs.mkdir(path.dirname(store), { recursive: true });
      await fs.writeFile(
        path.join(path.dirname(store), "owned-session.jsonl"),
        [
          JSON.stringify({ type: "session", version: 1, id: "owned-session" }),
          JSON.stringify({
            type: "message",
            timestamp: new Date(now).toISOString(),
            message: {
              role: "assistant",
              model: "gpt-5.4",
              provider: "openai",
              usage: { input: 50, output: 50, totalTokens: 100, cost: { total: 0.1 } },
            },
          }),
          "",
        ].join("\n"),
        "utf-8",
      );

      const totals: number[] = [];
      for (const agentId of ["main", "beta"]) {
        const summary = await loadCostUsageSummaryFromCache({
          agentId,
          config,
          startMs: now - 3_600_000,
          endMs: now + 3_600_000,
          refreshMode: "sync-when-empty",
        });
        totals.push(summary.totals.totalTokens);
      }
      expect(totals).toEqual([100, 0]);
    });
  });

  it("counts legacy transcripts for the owner even when the store filename is custom", async () => {
    const root = await suiteRootTracker.make("canonical-dir-custom-filename");
    const stateDir = path.join(root, "state");
    // The basename is not what names the owner: `my-store.json` in `agents/main/sessions/`
    // is still main's directory. Deriving ownership from `sessions.json` alone dropped
    // these files for every agent, main included.
    const store = path.join(stateDir, "agents", "main", "sessions", "my-store.json");
    const config = {
      agents: { entries: { main: { default: true }, beta: {} } },
      session: { store },
    } as unknown as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await fs.mkdir(path.dirname(store), { recursive: true });
      await fs.writeFile(
        path.join(path.dirname(store), "custom-named-session.jsonl"),
        [
          JSON.stringify({ type: "session", version: 1, id: "custom-named-session" }),
          JSON.stringify({
            type: "message",
            timestamp: new Date(now).toISOString(),
            message: {
              role: "assistant",
              model: "gpt-5.4",
              provider: "openai",
              usage: { input: 50, output: 50, totalTokens: 100, cost: { total: 0.1 } },
            },
          }),
          "",
        ].join("\n"),
        "utf-8",
      );

      const totals: number[] = [];
      for (const agentId of ["main", "beta"]) {
        const summary = await loadCostUsageSummaryFromCache({
          agentId,
          config,
          startMs: now - 3_600_000,
          endMs: now + 3_600_000,
          refreshMode: "sync-when-empty",
        });
        totals.push(summary.totals.totalTokens);
      }
      expect(totals).toEqual([100, 0]);
    });
  });

  it("gives a shared directory to the sole configured agent, not to whoever asks", async () => {
    const root = await suiteRootTracker.make("sole-agent-other-caller");
    const store = path.join(root, "shared", "team-store.json");
    // Discovery fans out over the gateway roster, which admits agents this config does
    // not, and a per-agent request may name any id. Answering on roster size alone let
    // every caller claim the same directory and counted it once per caller.
    const config = { session: { store } } as unknown as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      await fs.mkdir(path.dirname(store), { recursive: true });
      await fs.writeFile(
        path.join(path.dirname(store), "unclaimed-session.jsonl"),
        [
          JSON.stringify({ type: "session", version: 1, id: "unclaimed-session" }),
          JSON.stringify({
            type: "message",
            timestamp: new Date(now).toISOString(),
            message: {
              role: "assistant",
              model: "gpt-5.4",
              provider: "openai",
              usage: { input: 50, output: 50, totalTokens: 100, cost: { total: 0.1 } },
            },
          }),
          "",
        ].join("\n"),
        "utf-8",
      );

      const totals: number[] = [];
      for (const agentId of ["main", "beta"]) {
        const summary = await loadCostUsageSummaryFromCache({
          agentId,
          config,
          startMs: now - 3_600_000,
          endMs: now + 3_600_000,
          refreshMode: "sync-when-empty",
        });
        totals.push(summary.totals.totalTokens);
      }
      // 100 once, not once per caller.
      expect(totals).toEqual([100, 0]);
    });
  });

  it("charges no agent when only the store filename is templated, so the directory is shared", async () => {
    const root = await suiteRootTracker.make("filename-template");
    // `<dir>/{agentId}.json` gives each agent its own database but one shared
    // directory, so the legacy files in it still need a single owner.
    const store = path.join(root, "srv", "{agentId}.json");
    const config = {
      agents: { entries: { alpha: { default: true }, beta: {} } },
      session: { store },
    } as unknown as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      await fs.mkdir(path.join(root, "srv"), { recursive: true });
      await fs.writeFile(
        path.join(root, "srv", "legacy-session.jsonl"),
        [
          JSON.stringify({ type: "session", version: 1, id: "legacy-session" }),
          JSON.stringify({
            type: "message",
            timestamp: new Date(now).toISOString(),
            message: {
              role: "assistant",
              model: "gpt-5.4",
              provider: "openai",
              usage: { input: 50, output: 50, totalTokens: 100, cost: { total: 0.1 } },
            },
          }),
          "",
        ].join("\n"),
        "utf-8",
      );

      const totals: number[] = [];
      for (const agentId of ["alpha", "beta"]) {
        const summary = await loadCostUsageSummaryFromCache({
          agentId,
          config,
          startMs: now - 3_600_000,
          endMs: now + 3_600_000,
          refreshMode: "sync-when-empty",
        });
        totals.push(summary.totals.totalTokens);
      }
      expect(totals).toEqual([0, 0]);
    });
  });

  it("returns nothing instead of throwing when a fixed store names another agent's database", async () => {
    const root = await suiteRootTracker.make("canonical-store");
    const stateDir = path.join(root, "state");
    // A fixed store pointing at one agent's own canonical store. Reading it as any
    // other agent is rejected by the scope resolver, and one throw would abort the
    // all-agent usage fan-out.
    const store = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const config = {
      agents: { entries: { main: { default: true }, beta: {} } },
      session: { store },
    } as unknown as OpenClawConfig;
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await fs.mkdir(path.dirname(store), { recursive: true });
      await writeUsageTurn({
        agentId: "main",
        sessionId: "main-session",
        storePath: store,
        timestampMs: now,
      });

      const totals: number[] = [];
      for (const agentId of ["main", "beta"]) {
        const summary = await loadCostUsageSummaryFromCache({
          agentId,
          config,
          startMs: now - 3_600_000,
          endMs: now + 3_600_000,
          refreshMode: "sync-when-empty",
        });
        totals.push(summary.totals.totalTokens);
      }
      expect(totals).toEqual([18, 0]);
      await expect(discoverAllSessions({ agentId: "beta", config })).resolves.toEqual([]);
    });
  });

  it("keeps scanning the default store when session.store is unset", async () => {
    const root = await suiteRootTracker.make("default-store");
    const agentId = "main";
    const sessionId = "default-store-session";
    const now = Date.now();

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      await writeUsageTurn({ agentId, sessionId, timestampMs: now });

      const summary = await loadCostUsageSummaryFromCache({
        agentId,
        config: {} as OpenClawConfig,
        startMs: now - 3_600_000,
        endMs: now + 3_600_000,
        refreshMode: "sync-when-empty",
      });
      expect(summary.totals.totalTokens).toBe(18);

      const discovered = await discoverAllSessions({ agentId, config: {} as OpenClawConfig });
      expect(discovered.map((session) => session.sessionId)).toEqual([sessionId]);
    });
  });
});
