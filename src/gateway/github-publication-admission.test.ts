import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { updateUserGitHubConnection } from "../state/user-github-connections.js";
import { readPersonalGitHubPublication } from "./github-personal-publication-store.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount,
} from "./github-personal-publication.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.js";
import {
  SESSION_ID,
  SESSION_KEY,
  commands,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();
const publisher = { source: "system-configured" as const, accountId: 42, login: "roboclaw-bot" };
const obsolete = { ...publisher, accountId: 41, login: "previous-publisher" };
const rejection = (idempotencyKey: string) => ({
  code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
  idempotencyKey,
});

function sharedAdmission(surface: "local" | "deferred" | "claim") {
  const db = openOpenClawStateDatabase().db;
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  const coordinator = createTestGitHubPublicationCoordinator({ placements });
  const sessionId = surface === "local" ? SESSION_ID : REQUEST.sessionId;
  const sessionKey = surface === "local" ? SESSION_KEY : REQUEST.sessionKey;
  if (surface !== "local") {
    seedActivePlacement(placements, { environmentId: "publication-worker", ownerEpoch: 2 });
  }
  const claim =
    surface === "claim"
      ? placements.claimTurn({
          sessionId,
          sessionKey,
          agentId: "main",
          claimId: "publication-claim",
          runId: "publication-run",
          owner: { kind: "worker", environmentId: "publication-worker", ownerEpoch: 2 },
        })
      : undefined;
  const key = `selected-${surface}`;
  return {
    db,
    key,
    read: () => readGitHubPublicationRequest(db, { sessionId, idempotencyKey: key }),
    request: (expected = obsolete) =>
      claim
        ? coordinator.requestForClaim({
            claim,
            sessionKey,
            agentId: "main",
            idempotencyKey: key,
            expectedPublisher: expected,
          })
        : coordinator.requestForSession({
            sessionKey,
            agentId: "main",
            idempotencyKey: key,
            selection: { source: "shared", expected },
          }),
  };
}

describe("GitHub publication selection admission", () => {
  installGitHubPublicationTestHarness();
  afterEach(() => vi.unstubAllGlobals());

  it.each(["local", "deferred", "claim"] as const)(
    "records a fresh %s selection rejection before any durable request or Git effect",
    async (surface) => {
      const fixture = sharedAdmission(surface);
      const error = await fixture.request().catch((caught: unknown) => caught);
      expect(fixture.read()).toBeUndefined();
      expect(commands).toEqual([]);
      expect(error).toMatchObject({ rejection: rejection(fixture.key) });
    },
  );

  it.each(["local", "deferred", "claim"] as const)(
    "does not reinterpret an existing %s receipt as a pre-admission rejection",
    async (surface) => {
      const fixture = sharedAdmission(surface);
      await fixture.request(publisher);
      const before = fixture.read();
      const effects = [...commands];
      const error = await fixture.request().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("rejection.idempotencyKey");
      expect(fixture.read()).toEqual(before);
      expect(commands).toEqual(effects);
    },
  );

  it.each(["deferred", "claim"] as const)(
    "observes a same-key %s admission committed while identity preparation awaits",
    async (surface) => {
      const fixture = sharedAdmission(surface);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const identity = await mocks.prepareIdentity();
      mocks.prepareIdentity.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return identity;
      });
      const stale = fixture.request().catch((caught: unknown) => caught);
      await entered.promise;
      let admitted;
      try {
        admitted = await fixture.request(publisher);
      } finally {
        release.resolve();
      }
      const error = await stale;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toHaveProperty("rejection.idempotencyKey");
      expect(fixture.read()?.request_id).toBe(admitted.requestId);
      expect(commands).toEqual([]);
    },
  );

  it("does not make a key-wide promise when another invocation is still preparing", async () => {
    const fixture = sharedAdmission("local");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const identity = await mocks.prepareIdentity();
    mocks.prepareIdentity.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return identity;
    });
    const pending = fixture.request(publisher);
    await entered.promise;
    let error: unknown;
    try {
      error = await fixture.request().catch((caught: unknown) => caught);
      expect(fixture.read()).toBeUndefined();
    } finally {
      release.resolve();
    }
    const admitted = await pending;
    expect(error).toMatchObject({ rejection: rejection(fixture.key) });
    expect(fixture.read()?.request_id).toBe(admitted.requestId);
    expect(commands.filter((args) => args.includes("push"))).toHaveLength(1);
    expect(commands.filter((args) => args.includes("POST"))).toHaveLength(1);
  });

  it("does not forget a receipt already observed before an awaited identity refresh", async () => {
    const fixture = sharedAdmission("deferred");
    await fixture.request(publisher);
    mocks.refreshIdentity.mockImplementationOnce(async () => {
      fixture.db
        .prepare("DELETE FROM github_publication_requests WHERE idempotency_key = ?")
        .run(fixture.key);
    });
    const error = await fixture.request().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("rejection.idempotencyKey");
    expect(fixture.read()).toBeUndefined();
    expect(commands).toEqual([]);
  });

  it.each(["initial", "refresh", "target", "snapshot"] as const)(
    "returns exact personal pre-insert rejection details when selection changes at %s",
    async (phase) => {
      const fixture = await createPersonalPublicationFixture();
      const key = `personal-rejected-${phase}`;
      const request = {
        sessionKey: SESSION_KEY,
        idempotencyKey: key,
        selection: {
          source: "personal",
          generation: fixture.generation,
          account: personalPublicationAccount,
        },
      };
      const rotate = () =>
        updateUserGitHubConnection(
          fixture.owner,
          (current) => ({ ...current!, generation: "f7cb52c6-1d4f-4012-aeae-e31b00f41456" }),
          () => {},
        );
      if (phase === "initial") {
        rotate();
      } else if (phase === "refresh") {
        mocks.refreshIdentity.mockImplementationOnce(async () => rotate());
      } else if (phase === "target") {
        const resolve = mocks.resolveRepository.getMockImplementation()!;
        mocks.resolveRepository.mockImplementationOnce(async () => {
          const target = await resolve();
          rotate();
          return target;
        });
      } else {
        const run = mocks.runCommand.getMockImplementation()!;
        mocks.runCommand.mockImplementation(
          async (args: string[], options?: { input?: string }) => {
            const result = await run(args, options);
            if (args.includes("write-tree")) {
              rotate();
            }
            return result;
          },
        );
      }
      const response = await callPersonalPublicationRpc(
        fixture,
        "sessions.github.publish",
        request,
      );
      expect(response[0]).toBe(false);
      expect(
        readPersonalGitHubPublication(fixture.owner, {
          sessionId: SESSION_ID,
          idempotencyKey: key,
        }),
      ).toBeUndefined();
      expect(commands.some((args) => args.includes("push") || args.includes("POST"))).toBe(false);
      expect(response).toMatchObject([false, undefined, { details: rejection(key) }]);
    },
  );

  it("keeps an accepted personal pre-claim identity stop attached to its durable receipt", async () => {
    const fixture = await createPersonalPublicationFixture();
    fixture.runtime.verifiedAccount = { ...personalPublicationAccount, login: "renamed-account" };
    const key = "accepted-personal-pre-claim";
    const response = await callPersonalPublicationRpc(fixture, "sessions.github.publish", {
      sessionKey: SESSION_KEY,
      idempotencyKey: key,
      selection: {
        source: "personal",
        generation: fixture.generation,
        account: personalPublicationAccount,
      },
    });
    expect(response[0]).toBe(false);
    expect(response[2]).not.toHaveProperty("details");
    const row = readPersonalGitHubPublication(fixture.owner, {
      sessionId: SESSION_ID,
      idempotencyKey: key,
    });
    expect(row).toMatchObject({ status: "requested", execution_id: null });
    expect(
      fixture.coordinator.personalStatus(fixture.action, fixture.action, row!.request_id),
    ).toMatchObject({
      result: { status: "failed", code: "identity_changed" },
      confirmation: null,
    });
    expect(commands.some((args) => args.includes("push") || args.includes("POST"))).toBe(false);
  });
});
