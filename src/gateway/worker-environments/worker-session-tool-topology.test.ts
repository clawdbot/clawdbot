import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../../packages/gateway-protocol/src/index.js";
import type { AgentToolGatewayRequestCaller } from "../../agents/tools/in-process-gateway.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../../config/sessions.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { captureGatewaySessionWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db.js";
import { GatewayClientRequestError } from "../client.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { executeWorkerSessionSend } from "./worker-session-tool-send.js";
import {
  resolveWorkerSessionToolTarget,
  type WorkerSessionToolSource,
} from "./worker-session-tool-topology.js";

const parentId = "00000000-0000-4000-8000-000000000001";
const childId = "00000000-0000-4000-8000-000000000002";
const siblingId = "00000000-0000-4000-8000-000000000003";
const siblingKey = "agent:worker:dashboard:sibling";

describe("worker family owner resolution", () => {
  let root: string;
  let cfg: OpenClawConfig;
  let source: WorkerSessionToolSource;
  const write = (agentId: string, sessionKey: string, entry: SessionEntry) =>
    replaceSessionEntrySync(
      {
        agentId,
        sessionKey,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
      },
      entry,
    );
  const resolve = (requestedSessionKey: string) =>
    resolveWorkerSessionToolTarget({ source, requestedSessionKey });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-family-owner-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    cfg = retainLegacyDefaultAgentId(
      { agents: { entries: { main: {}, ops: {}, worker: {} } }, session: { scope: "global" } },
      "main",
    );
    setRuntimeConfigSnapshot(cfg);
    source = {
      agentId: "worker",
      sessionKey: "agent:worker:dashboard:child",
      sessionId: childId,
      turnClaim: {
        claimId: "claim",
        runId: "run",
        sessionId: childId,
        placementGeneration: 1,
        owner: { kind: "worker", environmentId: "environment", ownerEpoch: 1 },
      },
      entry: {
        sessionId: childId,
        updatedAt: 1,
        parentSessionKey: "global",
        parentSessionId: parentId,
      },
    };
    write("main", "global", { sessionId: "different-parent", updatedAt: 1 });
    write("ops", "global", { sessionId: parentId, updatedAt: 1 });
    write("worker", siblingKey, {
      sessionId: siblingId,
      updatedAt: 1,
      parentSessionKey: "global",
      parentSessionId: parentId,
    });
  });

  afterEach(async () => {
    clearRuntimeConfigSnapshot();
    closeOpenClawAgentDatabases();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("resolves a non-default global parent and retains its owner for cross-agent siblings", () => {
    expect(resolve("global")).toEqual({
      agentId: "ops",
      sessionKey: "global",
      sessionId: parentId,
    });
    expect(resolve(siblingKey)).toEqual({
      agentId: "worker",
      sessionKey: siblingKey,
      sessionId: siblingId,
      topologyParent: { agentId: "ops", sessionKey: "global", sessionId: parentId },
    });
  });

  it("keeps direct child authority independent of the source's replaced ancestor", () => {
    write("ops", "global", { sessionId: "replacement-parent", updatedAt: 2 });
    write("worker", siblingKey, {
      sessionId: siblingId,
      updatedAt: 2,
      parentSessionKey: source.sessionKey,
      parentSessionId: childId,
    });
    expect(resolve(siblingKey)).toEqual({
      agentId: "worker",
      sessionKey: siblingKey,
      sessionId: siblingId,
    });
  });

  it.each(["missing", "replaced", "archived", "ambiguous"] as const)(
    "rejects a %s parent for both direct and sibling messaging",
    (state) => {
      if (state === "missing") {
        source.entry.parentSessionId = "absent-parent";
      }
      if (state === "replaced") {
        write("ops", "global", { sessionId: "replacement", updatedAt: 2 });
      }
      if (state === "archived") {
        write("ops", "global", { sessionId: parentId, updatedAt: 2, archivedAt: 2 });
      }
      if (state === "ambiguous") {
        write("main", "global", { sessionId: parentId, updatedAt: 2 });
      }
      expect(() => resolve("global")).toThrow(/not an exact live session/);
      expect(() => resolve(siblingKey)).toThrow(/outside the authorized session tree/);
    },
  );

  it.each(["per-agent", "fixed"] as const)(
    "carries the selected parent owner through core send and %s store admission",
    async (store) => {
      cfg = {
        ...cfg,
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
        ...(store === "fixed"
          ? {
              agents: { ...cfg.agents, defaults: { sessionStore: { agentId: "ops" } } },
              session: { scope: "global", store: path.join(root, "shared.sqlite") },
            }
          : {}),
      };
      setRuntimeConfigSnapshot(cfg);
      write("ops", "global", { sessionId: parentId, updatedAt: 1 });
      write(source.agentId, source.sessionKey, source.entry);
      const target = resolve("global");
      const scope = {
        scope: resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" }),
        sessionKey: "global",
        sessionId: parentId,
      };
      const resolveGatewayContext = () => undefined;
      let admissions: ReturnType<typeof captureGatewaySessionWorkAdmissions> | undefined;
      const dispatched: unknown[] = [];
      const callGateway: AgentToolGatewayRequestCaller = async <T>(
        request: Parameters<AgentToolGatewayRequestCaller>[0],
      ) => {
        if (request.method === "sessions.resolve") {
          const result = await resolveSessionKeyFromResolveParams({
            cfg,
            client: null,
            p: request.params as SessionsResolveParams,
          });
          if (!result.ok) {
            throw new GatewayClientRequestError({
              code: result.error.code,
              message: result.error.message,
            });
          }
          return result as T;
        }
        if (request.method !== "agent") {
          throw new Error(`Unexpected Gateway method: ${request.method}`);
        }
        admissions = captureGatewaySessionWorkAdmissions(resolveGatewayContext);
        expect(admissions.isActive(scope)).toBe(true);
        dispatched.push(request.params);
        return { runId: "admitted-parent-run", status: "accepted" } as T;
      };
      const result = await withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
        executeWorkerSessionSend({
          source,
          target,
          request: {
            toolCallId: "owner-send",
            sessionKey: "global",
            message: "Report to this parent",
            timeoutSeconds: 0,
          },
          idempotencyKey: "owner-send",
          assertSource: () => {},
          callGateway,
        }),
      );
      expect(result.details).toMatchObject({ status: "accepted", sessionKey: target.sessionKey });
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      expect(JSON.parse(text)).toMatchObject({ status: "accepted", sessionKey: target.sessionKey });
      expect(dispatched).toEqual([
        expect.objectContaining({
          agentId: "ops",
          sessionKey: "global",
          message: expect.stringContaining("Report to this parent"),
        }),
      ]);
      expect(admissions?.isActive(scope)).toBe(false);
    },
  );

  it("honors one durable fixed-store owner without counting the shared row for every agent", () => {
    cfg = {
      ...cfg,
      agents: { ...cfg.agents, defaults: { sessionStore: { agentId: "ops" } } },
      session: { scope: "global", store: path.join(root, "shared.sqlite") },
    };
    setRuntimeConfigSnapshot(cfg);
    write("ops", "global", { sessionId: parentId, updatedAt: 1 });
    expect(resolve("global")).toEqual({
      agentId: "ops",
      sessionKey: "global",
      sessionId: parentId,
    });
  });
});
