import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPersonalGitHubPublication } from "./github-personal-publication-store.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
} from "./github-personal-publication.test-support.js";
import {
  BRANCH,
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  createRealPublicationWorkspace,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";

const mocks = githubPublicationTestMocks();
vi.mock("../agents/worktrees/git-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/worktrees/git-lock.js")>()),
  lockWorktreeForProcess: vi.fn(async () => undefined),
  unlockWorktree: vi.fn(async () => undefined),
}));
vi.mock("../process/exec.js", () => ({
  runCommandBuffered: (
    ...args: Parameters<typeof import("../process/exec.js").runCommandBuffered>
  ) => mocks.runCommand(...args),
}));

describe("personal publication definitive outcomes", () => {
  installGitHubPublicationTestHarness();
  let fixture: Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
  beforeEach(async () => {
    fixture = await createPersonalPublicationFixture();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const rpc = (method: string, params?: Record<string, unknown>) =>
    callPersonalPublicationRpc(fixture, method, params);
  const request = () => ({
    sessionKey: SESSION_KEY,
    idempotencyKey: "personal-publish",
    selection: { source: "personal" as const, generation: fixture.generation, account },
  });
  const status = (requestId: string) =>
    fixture.coordinator.personalStatus(
      fixture.action,
      { sessionKey: SESSION_KEY, sessionId: SESSION_ID, agentId: "main" },
      requestId,
    );
  it.each([
    "closed",
    "closed-before-unavailable",
    "closed-with-foreign",
    "closed-after-create",
    "closed-after-lost-create",
    "no-changes",
    "foreign",
    "foreign-after-create",
    "revoked",
    "revoked-after-create",
    "unavailable-after-create",
    "malformed-after-create",
    "timeout-after-create",
  ] as const)(
    "preserves the original request outcome for %s observation after an earlier effect",
    async (outcome) => {
      const { owner, generation, client } = fixture;
      const foreign = outcome.startsWith("foreign");
      const revoked = outcome.startsWith("revoked");
      const afterCreate = outcome.endsWith("after-create");
      const unavailable = /^(unavailable|malformed|timeout)/u.test(outcome);
      const workspace = await createRealPublicationWorkspace(
        outcome === "closed-after-lost-create" ? "create" : "push",
      );
      const initial = (await rpc("sessions.github.publish", request()))[1];
      expect(initial.status).toBe("needs_confirmation");
      const pending = status(initial.requestId);
      const confirm = {
        sessionKey: SESSION_KEY,
        requestId: initial.requestId,
        generation,
        account,
        requestDigest: pending.confirmation!.requestDigest,
      };
      const headSha = await workspace.git("rev-parse", "HEAD");
      const marker = `<!-- openclaw-publication:${initial.requestId} -->`;
      const url = "https://github.com/openclaw/openclaw/pull/125203";
      const remote = mocks.runCommand.getMockImplementation()!;
      let created = false;
      let lookups = 0;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        if (
          outcome === "no-changes" &&
          argv.some((arg) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"))
        ) {
          return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: headSha }));
        }
        if (argv.includes("POST")) {
          expect(JSON.parse(options?.input ?? "{}").body).toContain(marker);
          await remote(argv, options);
          created = true;
          return commandResult("", 1);
        }
        if (argv.includes("state=all")) {
          if (afterCreate && !created) {
            return commandResult("[]");
          }
          if (outcome === "unavailable-after-create") {
            return commandResult("", 1);
          }
          if (outcome === "malformed-after-create") {
            return commandResult("[{}");
          }
          if (outcome === "timeout-after-create") {
            throw new Error("synthetic remote timeout");
          }
          lookups += 1;
          if (outcome === "closed-before-unavailable" && lookups > 1) {
            throw new Error("synthetic later lookup unavailable");
          }
          if (revoked && lookups === 1) {
            client.connect.scopes = ["operator.read"];
          }
          return commandResult(
            JSON.stringify([
              {
                url,
                userId: foreign ? 202 : account.accountId,
                state: foreign ? "open" : "closed",
                body: marker,
                headSha,
                headRef: BRANCH,
                baseRef: "main",
              },
              ...(outcome === "closed-with-foreign"
                ? [
                    {
                      url: "https://github.com/openclaw/openclaw/pull/125204",
                      userId: 202,
                      state: "open",
                      body: "",
                      headSha,
                      headRef: BRANCH,
                      baseRef: "main",
                    },
                  ]
                : []),
            ]),
          );
        }
        return await remote(argv, options);
      });
      const confirmed = await rpc("sessions.github.confirm", confirm);
      expect(workspace.effects).toEqual(
        afterCreate || outcome === "closed-after-lost-create" ? ["push", "pull_request"] : ["push"],
      );
      if (unavailable) {
        expect(confirmed[0]).toBe(true);
        expect(confirmed[1]).toMatchObject({
          status: "needs_confirmation",
          requestId: initial.requestId,
          publisher: initial.publisher,
          effect: { kind: "pull_request", status: "dispatched", headCommit: headSha },
        });
        expect(status(initial.requestId).confirmation).toEqual(pending.confirmation);
        return;
      }
      if (revoked) {
        expect(confirmed[0]).toBe(false);
        expect(readPersonalGitHubPublication(owner, { requestId: initial.requestId })?.status).toBe(
          "needs_confirmation",
        );
        expect(
          readPersonalGitHubPublication(owner, { requestId: initial.requestId }),
        ).toMatchObject({
          last_effect: "pull_request",
          effect_state: "observed",
          pull_request_url: url,
        });
        return;
      }
      expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
      const closed = outcome.startsWith("closed");
      expect(confirmed[1]).toMatchObject({
        requestId: initial.requestId,
        status: "failed",
        publisher: initial.publisher,
        code: outcome === "no-changes" ? "no_changes" : "github_rejected",
        effect: closed
          ? { kind: "pull_request", status: "observed", headCommit: headSha, url }
          : afterCreate
            ? { kind: "pull_request", status: "dispatched", headCommit: headSha }
            : initial.effect,
        nextAction: expect.stringContaining(
          closed ? "Reopen" : outcome === "no-changes" ? "change" : "permission",
        ),
      });
      expect(status(initial.requestId)).toEqual({ result: confirmed[1], confirmation: null });
      expect((await rpc("sessions.github.options"))[1].pendingPersonal).toBeNull();
      expect((await rpc("sessions.github.publish", request()))[1]).toEqual(confirmed[1]);
      expect((await rpc("sessions.github.confirm", confirm))[1]).toEqual(confirmed[1]);
      expect(workspace.effects).toEqual(
        afterCreate || outcome === "closed-after-lost-create" ? ["push", "pull_request"] : ["push"],
      );
      mocks.runCommand.mockImplementation(remote);
      const fresh = await rpc("sessions.github.publish", {
        ...request(),
        idempotencyKey: "fresh-reviewed-outcome",
      });
      expect(fresh[0], JSON.stringify(fresh[2])).toBe(true);
      expect(fresh[1].status).toBe("published");
      expect(fresh[1].requestId).not.toBe(initial.requestId);
    },
  );
});
