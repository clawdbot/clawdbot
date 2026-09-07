import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { prepareCurrentGitHubPublicationIdentity } from "./github-publication-availability.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import {
  resolveGatewaySessionStoreTargetWithStore,
  resolveGatewaySessionStoreTargetsReadOnly,
} from "./session-utils-store-lookup.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

vi.mock("./github-publication-availability.js", () => ({
  prepareCurrentGitHubPublicationIdentity: vi.fn(async (agentId: string) => ({
    source: "system",
    account: { accountId: `account-${agentId}`, login: `synthetic-${agentId}` },
  })),
}));

async function withGlobalSessions(mainKey: string, run: (cfg: OpenClawConfig) => Promise<void>) {
  await withStateDirEnv("gateway-global-lookup-", async ({ stateDir }) => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {}, research: {} } },
      session: {
        scope: "global",
        mainKey,
        store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, cfg);
    try {
      for (const agentId of ["main", "research"]) {
        for (const sessionKey of ["global", `agent:${agentId}:global`]) {
          await replaceSessionEntry(
            { agentId, sessionKey },
            { sessionId: `${agentId}-${sessionKey}`, updatedAt: 1 },
          );
        }
      }
      await run(cfg);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      resetConfigRuntimeState();
    }
  });
}

describe("global session lookup ownership", () => {
  it.each(["single", "batch", "read-only"] as const)(
    "preserves qualified main aliases and ordinary global keys through %s reads",
    async (mode) => {
      await withGlobalSessions("work", async (cfg) => {
        // Revisit Research after Main so shared sentinels cannot adopt the previous owner.
        const requests = ["research", "main", "research"].flatMap((agentId) =>
          ["main", "work", "global"].map((suffix) => ({
            key: `agent:${agentId}:${suffix}`,
            agentId,
            canonicalKey: suffix === "global" ? `agent:${agentId}:global` : "global",
          })),
        );
        const targets =
          mode === "batch"
            ? resolveGatewaySessionStoreTargetsReadOnly({
                cfg,
                targets: requests.map(({ key }) => ({ key })),
              })
            : requests.map(({ key }) =>
                mode === "single"
                  ? resolveGatewaySessionStoreTargetWithStore({ cfg, key })
                  : loadGatewaySessionEntryReadOnly(key),
              );
        expect(
          targets.map((target) => ({
            agentId: target.agentId,
            canonicalKey: target.canonicalKey,
            sessionId: target.store[target.canonicalKey]?.sessionId,
          })),
        ).toEqual(
          requests.map(({ agentId, canonicalKey }) => ({
            agentId,
            canonicalKey,
            sessionId: `${agentId}-${canonicalKey}`,
          })),
        );
      });
    },
  );

  it.each(["single", "batch", "read-only"] as const)(
    "rejects contradictory key and fixed-store owners through %s reads",
    async (mode) => {
      await withGlobalSessions("main", async (cfg) => {
        const read = (config: OpenClawConfig, key: string, agentId?: string) => {
          setRuntimeConfigSnapshot(config, config);
          return mode === "batch"
            ? resolveGatewaySessionStoreTargetsReadOnly({
                cfg: config,
                targets: [{ key, agentId }],
              })
            : mode === "single"
              ? resolveGatewaySessionStoreTargetWithStore({ cfg: config, key, agentId })
              : loadGatewaySessionEntryReadOnly(key, { agentId });
        };
        for (const key of ["agent:main:main", "agent:main:global"]) {
          expect.soft(() => read(cfg, key, "research")).toThrow('belongs to "main"');
        }
        for (const owner of ["main", "retired"]) {
          const fixed: OpenClawConfig = {
            ...cfg,
            agents: { ...cfg.agents, defaults: { sessionStore: { agentId: owner } } },
            session: {
              ...cfg.session,
              store: cfg.session!.store!.replaceAll("{agentId}", "shared"),
            },
          };
          for (const key of ["global", "agent:research:main"]) {
            expect
              .soft(() => read(fixed, key, "research"))
              .toThrow(owner === "retired" ? 'retired agent "retired"' : 'belongs to "main"');
          }
        }
      });
    },
  );

  it("routes GitHub options and its access recheck to the qualified alias owner", async () => {
    await withGlobalSessions("main", async (cfg) => {
      const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
      for (const agentId of ["research", "main", "research"]) {
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: `options-${agentId}`,
            method: "sessions.github.options",
            params: { sessionKey: `agent:${agentId}:main` },
          },
          client: null,
          isWebchatConnect: () => false,
          context,
          respond,
        });
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[2]).toBeUndefined();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(respond.mock.calls[0]?.[1]).toEqual({
          personal: null,
          pendingPersonal: null,
          shared: {
            source: "system",
            accountId: `account-${agentId}`,
            login: `synthetic-${agentId}`,
          },
        });
        expect(prepareCurrentGitHubPublicationIdentity).toHaveBeenLastCalledWith(agentId);
      }
    });
  });
});
