import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { requestSkillWorkshopRevisionAdmission } from "../pages/skill-workshop/revision-admission.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";
import {
  createSkillWorkshopRevisionAdmissions,
  type SkillWorkshopRevisionAdmissionInput,
} from "./skill-workshop-revision-admissions.ts";

const input = (instructions: string): SkillWorkshopRevisionAdmissionInput => ({
  expectedRevisionHash: "a".repeat(64),
  instructions,
  proposalAgentId: "main",
  proposalId: "proposal-main",
  proposalSlug: "main-inbox-cleaner",
  useCurrentChatForRevisions: false,
});

type AdmittedExecutorResult = { sessionKey: string; status: "admitted" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function revisionContext(params: {
  agentId: string;
  client: GatewayBrowserClient;
  sessionId: string;
  sessionKey: string;
}): ApplicationContext {
  const snapshot = {
    client: params.client,
    phase: "connected",
    hello: gatewayHelloForMethods([]),
    assistantAgentId: params.agentId,
  } as unknown as ApplicationGatewaySnapshot;
  return {
    gateway: { snapshot },
    sessions: {
      state: {
        agentId: params.agentId,
        result: {
          sessions: [
            {
              key: params.sessionKey,
              sessionId: params.sessionId,
              agentId: params.agentId,
              archived: false,
              hasActiveRun: false,
            },
          ],
        },
        loading: false,
        error: null,
      },
    },
  } as unknown as ApplicationContext;
}

describe("Skill Workshop revision admission owner", () => {
  it("removes only the exact ACK-admitted entry", async () => {
    const owner = createSkillWorkshopRevisionAdmissions();
    const first = deferred<AdmittedExecutorResult>();
    const second = deferred<AdmittedExecutorResult>();
    const runA = owner.start(input("first"), () => first.promise);
    const runB = owner.start(input("second"), () => second.promise);

    second.resolve({ sessionKey: "agent:main:second", status: "admitted" });
    await expect(runB.completion).resolves.toEqual({
      id: runB.entry.id,
      sessionKey: "agent:main:second",
      status: "admitted",
    });

    expect(owner.get(runB.entry.id)).toBeNull();
    expect(owner.get(runA.entry.id)).toMatchObject({ instructions: "first", phase: "pending" });
  });

  it("retains failure and retries the same record and idempotency key", async () => {
    const owner = createSkillWorkshopRevisionAdmissions();
    const attempts: Array<ReturnType<typeof deferred<AdmittedExecutorResult>>> = [];
    const idempotencyKeys: string[] = [];
    const run = owner.start(input("retry exactly"), (entry) => {
      idempotencyKeys.push(entry.idempotencyKey);
      const attempt = deferred<AdmittedExecutorResult>();
      attempts.push(attempt);
      return attempt.promise;
    });
    attempts[0]!.reject(new Error("owner replaced"));
    await expect(run.completion).resolves.toMatchObject({ status: "retryable-failed" });

    expect(owner.firstFailed("main")).toMatchObject({
      expectedRevisionHash: "a".repeat(64),
      id: run.entry.id,
      instructions: "retry exactly",
      phase: "retryable-failed",
    });
    const retry = owner.retry(run.entry.id);
    expect(retry?.entry).toMatchObject({
      id: run.entry.id,
      idempotencyKey: run.entry.idempotencyKey,
      phase: "pending",
    });
    expect(idempotencyKeys).toEqual([run.entry.idempotencyKey, run.entry.idempotencyKey]);
    attempts[1]!.resolve({ sessionKey: "agent:main:retry", status: "admitted" });
    await expect(retry?.completion).resolves.toMatchObject({ status: "admitted" });
    expect(owner.get(run.entry.id)).toBeNull();
  });

  it("retires a changed proposal revision instead of making the stale decision retryable", async () => {
    const owner = createSkillWorkshopRevisionAdmissions();
    const run = owner.start(input("retry exactly"), async () => ({
      status: "revision-changed",
    }));

    await expect(run.completion).resolves.toEqual({
      id: run.entry.id,
      status: "revision-changed",
    });
    expect(owner.get(run.entry.id)).toBeNull();
    expect(owner.retry(run.entry.id)).toBeNull();
    expect(owner.firstFailed("main")).toBeNull();
  });

  it("classifies a typed stale Gateway reply at the lazy request boundary without replaying", async () => {
    const request = vi.fn(async () => {
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Skill proposal revision changed",
        details: {
          code: "SKILL_PROPOSAL_REVISION_CHANGED",
          currentRevisionHash: "b".repeat(64),
          expectedRevisionHash: "a".repeat(64),
        },
      });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = revisionContext({
      agentId: "main",
      client,
      sessionId: "session-main-workshop",
      sessionKey: "agent:main:workshop",
    });
    const entry = {
      ...input("preserve reviewed content"),
      id: "revision-admission",
      idempotencyKey: "revision-idempotency",
      phase: "pending" as const,
      proposalOriginSessionKey: "agent:main:workshop",
    };

    await expect(
      requestSkillWorkshopRevisionAdmission({ context, entry, materialize: vi.fn() }),
    ).resolves.toEqual({ status: "revision-changed" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "skills.proposals.requestRevision",
      expect.objectContaining({
        expectedRevisionHash: "a".repeat(64),
        idempotencyKey: "revision-idempotency",
        sessionKey: "agent:main:workshop",
      }),
    );
  });

  it("keeps overlapping failures independent and reveals them in insertion order", async () => {
    const owner = createSkillWorkshopRevisionAdmissions();
    const first = deferred<AdmittedExecutorResult>();
    const second = deferred<AdmittedExecutorResult>();
    const runA = owner.start(input("first failed"), () => first.promise);
    const runB = owner.start(input("second failed"), () => second.promise);

    second.reject(new Error("second error"));
    first.reject(new Error("first error"));
    await Promise.all([runA.completion, runB.completion]);

    expect(owner.firstFailed("main")).toMatchObject({
      id: runA.entry.id,
      instructions: "first failed",
    });
    expect(owner.get(runB.entry.id)).toMatchObject({
      error: "second error",
      instructions: "second failed",
    });
  });

  it("materializes a manifest-only proposal once and reuses its binding on retry", async () => {
    const revisionHash = "b".repeat(64);
    let admissionAttempts = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "skills.proposals.inspect") {
        return {
          content: "# Second proposal",
          record: {
            id: "proposal-second",
            kind: "update",
            status: "pending",
            title: "Second proposal",
            description: "Manifest-only proposal",
            createdAt: "2026-08-18T00:00:00.000Z",
            updatedAt: "2026-08-18T00:00:00.000Z",
            proposedVersion: "v1",
            draftHash: "draft-second",
            origin: {
              agentId: "research",
              sessionKey: "agent:research:second",
            },
            target: { skillName: "Second proposal", skillKey: "proposal-second" },
          },
          revisionHash,
          supportFiles: [],
        };
      }
      admissionAttempts += 1;
      if (admissionAttempts === 1) {
        throw new Error("owner replaced");
      }
      return { status: "started" };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const context = revisionContext({
      agentId: "research",
      client,
      sessionId: "session-second",
      sessionKey: "agent:research:second",
    });
    const owner = createSkillWorkshopRevisionAdmissions();
    const run = owner.start(
      {
        ...input("revise the second"),
        expectedRevisionHash: undefined,
        proposalAgentId: "research",
        proposalId: "proposal-second",
        proposalSlug: "proposal-second",
      },
      (entry, materialize) =>
        requestSkillWorkshopRevisionAdmission({ context, entry, materialize }),
    );

    await expect(run.completion).resolves.toMatchObject({ status: "retryable-failed" });
    expect(owner.get(run.entry.id)).toMatchObject({ expectedRevisionHash: revisionHash });
    const retry = owner.retry(run.entry.id);
    await expect(retry?.completion).resolves.toMatchObject({
      sessionKey: "agent:research:second",
      status: "admitted",
    });

    const inspectCalls = request.mock.calls.filter(
      ([method]) => method === "skills.proposals.inspect",
    );
    expect(inspectCalls).toEqual([
      ["skills.proposals.inspect", { agentId: "research", proposalId: "proposal-second" }],
    ]);
    const admissions = request.mock.calls.filter(
      ([method]) => method === "skills.proposals.requestRevision",
    );
    expect(admissions).toHaveLength(2);
    const firstParams = admissions[0]?.[1] as Record<string, unknown>;
    const secondParams = admissions[1]?.[1] as Record<string, unknown>;
    expect(firstParams).toMatchObject({
      expectedRevisionHash: revisionHash,
      instructions: "revise the second",
      proposalId: "proposal-second",
      sessionId: "session-second",
      sessionKey: "agent:research:second",
    });
    expect(secondParams).toMatchObject({ expectedRevisionHash: revisionHash });
    expect(secondParams.idempotencyKey).toBe(firstParams.idempotencyKey);
  });
});
