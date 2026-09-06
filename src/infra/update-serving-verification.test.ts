import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { rotateTranscriptGenerationInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { callGateway } from "../gateway/call.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readUpdateServingTranscript } from "./update-serving-verification-readback.js";
import { UpdateServingReceiptSchema } from "./update-serving-verification-receipt.js";
import { verifyUpdateServing } from "./update-serving-verification.js";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("../gateway/call.js", () => ({
  callGateway: rpc,
  isGatewayTransportError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayTransportError",
}));
vi.mock("../gateway/probe-auth.js", () => ({
  resolveGatewayProbeAuthSafeWithSecretInputs: async () => ({ auth: {} }),
}));

type CallOptions = Parameters<typeof callGateway>[0];
type ProbeRequest = {
  agentId: string;
  sessionKey: string;
  message: string;
  idempotencyKey: string;
};
const gateway = { bootId: "boot-candidate", version: "2026.9.6", buildId: "build-candidate" };

function hello(server: Partial<HelloOk["server"]> = {}): HelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    server: { ...gateway, connId: "connection", ...server },
    features: { methods: ["agent", "health"], events: [] },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "operator", scopes: [] },
    policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
  };
}

beforeEach(() => {
  rpc.mockReset();
});
afterEach(() => closeOpenClawAgentDatabasesForTest());

async function fixture(
  run: (f: {
    verify: typeof verifyUpdateServing extends (p: infer P) => infer R
      ? (extra?: Partial<P>) => R
      : never;
    seed: (
      request: ProbeRequest,
      variation?: string,
    ) => Promise<Parameters<typeof readUpdateServingTranscript>[0] & { sessionId: string }>;
    rewrite: () => void;
  }) => Promise<void>,
  customStore = false,
) {
  await withOpenClawTestState({ label: "update-serving" }, async (state) => {
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: { auth: { mode: "none" } },
      ...(customStore ? { session: { store: state.path("custom", "sessions.json") } } : {}),
    };
    const sessionId = randomUUID();
    let lastRequest: ProbeRequest | undefined;
    function readbackParams(request: ProbeRequest) {
      return {
        config,
        env: state.env,
        agentId: request.agentId,
        sessionKey: request.sessionKey,
        sessionId,
        agentRunId: request.idempotencyKey,
        prompt: request.message,
        response: `update-verified-${request.idempotencyKey}`,
      };
    }
    function scopeFor(request: ProbeRequest) {
      return resolveSqliteScope({
        agentId: request.agentId,
        sessionKey: request.sessionKey,
        env: state.env,
        storePath: resolveSessionStorePathCore(config.session?.store, {
          agentId: request.agentId,
          env: state.env,
        }),
      });
    }
    const seed = async (request: ProbeRequest, variation = "complete") => {
      lastRequest = request;
      const scope = scopeFor(request);
      await upsertSessionEntryCore(
        {
          agentId: request.agentId,
          sessionKey: request.sessionKey,
          env: state.env,
          storePath: resolveSessionStorePathCore(config.session?.store, {
            agentId: request.agentId,
            env: state.env,
          }),
        },
        { sessionId, updatedAt: Date.now() },
      );
      const user = {
        type: "message",
        id: "user-entry",
        parentId: null,
        message: { role: "user", content: request.message },
      };
      const assistant = {
        type: "message",
        id: "assistant-entry",
        parentId: variation === "wrong-branch" ? null : "user-entry",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text:
                variation === "response-mismatch"
                  ? "The service is healthy."
                  : variation === "response-punctuation"
                    ? `Verified: update-verified-${request.idempotencyKey}.`
                    : variation === "response-prefix"
                      ? `not-update-verified-${request.idempotencyKey}`
                      : variation === "response-suffix"
                        ? `update-verified-${request.idempotencyKey}extra`
                        : `update-verified-${request.idempotencyKey}`,
            },
          ],
          provider: variation === "missing-provider" ? "" : "openai",
          model: variation === "missing-model" ? "" : "gpt-4.1-mini",
          stopReason:
            variation === "failed-assistant"
              ? "error"
              : variation === "tool-only"
                ? "toolUse"
                : "stop",
          __openclaw: { runId: variation === "wrong-run" ? randomUUID() : request.idempotencyKey },
        },
      };
      runOpenClawAgentWriteTransaction((database) => {
        appendTranscriptEventsInTransaction(
          database,
          { ...scope, sessionId },
          variation === "missing-assistant"
            ? [user]
            : variation === "trailing-tool"
              ? [
                  user,
                  assistant,
                  {
                    type: "message",
                    id: "tool-entry",
                    parentId: "assistant-entry",
                    message: { role: "toolResult", content: "pending tool result" },
                  },
                ]
              : [user, assistant],
        );
      }, toDatabaseOptions(scope));
      return readbackParams(request);
    };
    rpc.mockImplementation(async (options: CallOptions) => {
      options.onHelloOk?.(hello());
      options.signal?.throwIfAborted();
      if (options.method === "health") {
        return { ok: true };
      }
      const request = options.params as ProbeRequest;
      await seed(request);
      return {
        runId: request.idempotencyKey,
        status: "ok",
        result: { meta: { agentMeta: { sessionId } } },
      };
    });
    await run({
      verify: (extra) =>
        verifyUpdateServing({
          runId: randomUUID(),
          config,
          env: state.env,
          gatewayPort: 18789,
          expectedVersion: gateway.version,
          expectedBuildId: gateway.buildId,
          ...extra,
        }),
      seed,
      rewrite: () => {
        if (!lastRequest) {
          throw new Error("fixture has no transcript");
        }
        runOpenClawAgentWriteTransaction(
          (database) => {
            rotateTranscriptGenerationInTransaction(database, sessionId);
          },
          toDatabaseOptions(scopeFor(lastRequest)),
        );
      },
    });
  });
}

describe("update serving verification", () => {
  it.each([false, true])(
    "reads a committed turn from a fresh canonical reader (custom store: %s)",
    async (customStore) => {
      await fixture(async ({ verify }) => {
        const result = await verify();
        expect(result.status).toBe("verified");
        if (result.status !== "verified") {
          throw new Error("serving proof missing");
        }
        expect(UpdateServingReceiptSchema.safeParse(result.receipt).success).toBe(true);
        expect(result.receipt.gateway).toEqual(gateway);
        expect(result.receipt.transcript).toMatchObject({
          user: { entryId: "user-entry" },
          assistant: { entryId: "assistant-entry" },
        });
        expect(JSON.stringify(result.receipt)).not.toContain("update-verified-");
      }, customStore);
    },
  );

  it.each([
    ["missing-assistant", { status: "failed", reason: "persistence-missing" }],
    ["failed-assistant", { status: "failed", reason: "turn-incomplete" }],
    ["tool-only", { status: "failed", reason: "turn-incomplete" }],
    ["trailing-tool", { status: "failed", reason: "turn-incomplete" }],
    ["missing-provider", { status: "failed", reason: "turn-incomplete" }],
    ["missing-model", { status: "failed", reason: "turn-incomplete" }],
    ["wrong-run", { status: "failed", reason: "turn-incomplete" }],
    ["wrong-branch", { status: "failed", reason: "turn-incomplete" }],
    ["response-mismatch", { status: "failed", reason: "response-mismatch" }],
    ["response-prefix", { status: "failed", reason: "response-mismatch" }],
    ["response-suffix", { status: "failed", reason: "response-mismatch" }],
    ["response-punctuation", { status: "verified" }],
  ] as const)(
    "reports the persisted serving outcome after successful RPC/readiness: %s",
    async (variation, expected) => {
      await fixture(async ({ verify, seed }) => {
        rpc.mockImplementation(async (options: CallOptions) => {
          options.onHelloOk?.(hello());
          if (options.method === "health") {
            return { ok: true };
          }
          const request = options.params as ProbeRequest;
          const proof = await seed(request, variation);
          return {
            runId: request.idempotencyKey,
            status: "ok",
            result: { meta: { agentMeta: { sessionId: proof.sessionId } } },
          };
        });
        expect(await verify()).toMatchObject(expected);
      });
    },
  );

  it("uses the canonical persisted session ID when a CLI backend reports its native session ID", async () => {
    await fixture(async ({ verify, seed }) => {
      let canonicalSessionId: string | undefined;
      rpc.mockImplementation(async (options: CallOptions) => {
        options.onHelloOk?.(hello());
        if (options.method === "health") {
          return { ok: true };
        }
        const request = options.params as ProbeRequest;
        const proof = await seed(request);
        canonicalSessionId = proof.sessionId;
        return {
          runId: request.idempotencyKey,
          status: "ok",
          result: { meta: { agentMeta: { sessionId: "native-cli-session" } } },
        };
      });
      const result = await verify();
      expect(result.status).toBe("verified");
      if (result.status === "verified") {
        expect(result.receipt.sessionId).toBe(canonicalSessionId);
      }
    });
  });

  it("does not read an uncommitted assistant from an existing writer handle", async () => {
    await fixture(async ({ seed }) => {
      const request = {
        agentId: "main",
        sessionKey: "agent:main:update-check",
        message: "check",
        idempotencyKey: randomUUID(),
      };
      const proof = await seed(request, "missing-assistant");
      const scope = resolveSqliteScope({
        agentId: request.agentId,
        sessionKey: request.sessionKey,
        env: proof.env,
      });
      runOpenClawAgentWriteTransaction((database) => {
        appendTranscriptEventsInTransaction(database, { ...scope, sessionId: proof.sessionId }, [
          {
            type: "message",
            id: "pending-assistant",
            parentId: "user-entry",
            message: {
              role: "assistant",
              content: proof.response,
              stopReason: "stop",
              provider: "openai",
              model: "gpt-4.1-mini",
              __openclaw: { runId: proof.agentRunId },
            },
          },
        ]);
        expect(readUpdateServingTranscript(proof)).toEqual({ status: "not-found" });
      }, toDatabaseOptions(scope));
      expect(readUpdateServingTranscript(proof)).toMatchObject({
        status: "persisted",
        transcript: { assistant: { entryId: "pending-assistant" } },
      });
    });
  });

  it.each(["bootId", "version", "buildId"] as const)(
    "rejects a changed final runtime %s",
    async (field) => {
      await fixture(async ({ verify }) => {
        const initial = rpc.getMockImplementation()!;
        rpc.mockImplementation(async (options: CallOptions) => {
          if (options.method === "health") {
            options.onHelloOk?.(hello({ [field]: "changed" }));
            options.signal?.throwIfAborted();
            return {};
          }
          return initial(options);
        });
        expect(await verify()).toEqual({ status: "failed", reason: "runtime-changed" });
      });
    },
  );

  it("rejects a rewrite between persistence readback and the final runtime observation", async () => {
    await fixture(async ({ verify, rewrite }) => {
      const initial = rpc.getMockImplementation()!;
      rpc.mockImplementation(async (options: CallOptions) => {
        const result = await initial(options);
        if (options.method === "health") {
          rewrite();
        }
        return result;
      });
      expect(await verify()).toEqual({ status: "failed", reason: "persistence-changed" });
    });
  });

  it.each([
    {
      server: { bootId: undefined },
      expected: { status: "unavailable", reason: "identity-unavailable" },
    },
    {
      server: { version: "old-version" },
      expected: { status: "failed", reason: "runtime-mismatch" },
    },
    {
      server: { buildId: "other-build" },
      expected: { status: "failed", reason: "runtime-mismatch" },
    },
  ])("rejects unusable initial runtime identity $server", async ({ server, expected }) => {
    await fixture(async ({ verify }) => {
      rpc.mockImplementation(async (options: CallOptions) => {
        options.onHelloOk?.(hello(server));
        options.signal?.throwIfAborted();
        throw new Error("dispatch must not happen");
      });
      expect(await verify()).toEqual(expected);
    });
  });

  it.each(["timeout", "error", "yielded"])(
    "does not accept a nonterminal serving result: %s",
    async (status) => {
      await fixture(async ({ verify, seed }) => {
        rpc.mockImplementation(async (options: CallOptions) => {
          options.onHelloOk?.(hello());
          const request = options.params as ProbeRequest;
          const proof = await seed(request);
          return {
            runId: request.idempotencyKey,
            status: status === "yielded" ? "ok" : status,
            result: {
              meta: { yielded: status === "yielded", agentMeta: { sessionId: proof.sessionId } },
            },
          };
        });
        expect(await verify()).toEqual(
          status === "timeout"
            ? { status: "timeout", reason: "turn-timeout" }
            : { status: "failed", reason: "turn-failed" },
        );
      });
    },
  );

  it("distinguishes unavailable, caller abort, and deadline without disclosing errors", async () => {
    await fixture(async ({ verify }) => {
      rpc.mockRejectedValue(new Error("private provider detail"));
      expect(await verify()).toEqual({ status: "unavailable", reason: "gateway-unavailable" });
      const controller = new AbortController();
      controller.abort();
      expect(await verify({ signal: controller.signal })).toEqual({
        status: "failed",
        reason: "aborted",
      });
      rpc.mockImplementation(
        async (options: CallOptions) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("timed out")), {
              once: true,
            });
          }),
      );
      expect(await verify({ timeoutMs: 25 })).toEqual({ status: "timeout", reason: "deadline" });
    });
  });
});
