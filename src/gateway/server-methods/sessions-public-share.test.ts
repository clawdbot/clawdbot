import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionPublicShareSetResultSchema,
  SessionMembersListEvidenceResultSchema,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolvePublicSessionShareToken } from "../control-ui-public-session-token.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import { identifiedClient, sessionSharingTestContext } from "./sessions-sharing.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  closeOpenClawAgentDatabasesForTest();
});

const scope = { agentId: "main", sessionKey: "agent:main:public-example" };
const sessionId = "public-example-generation";

async function call(
  method: "session.publicShare.set" | "session.members.listEvidence",
  params: Record<string, unknown>,
  client: GatewayClient = identifiedClient("owner"),
) {
  const responses: Parameters<RespondFn>[] = [];
  await expectDefined(
    sessionSharingHandlers[method],
    "sharing handler",
  )({
    params,
    client,
    context: sessionSharingTestContext(vi.fn()),
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses[0];
}

async function createSession() {
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: "owner" },
  });
}

async function setPublic(enabled: boolean, client?: GatewayClient, expectedSessionId = sessionId) {
  return call("session.publicShare.set", { ...scope, expectedSessionId, enabled }, client);
}

describe("world-readable session publication management", () => {
  it("lets the owner publish, reuse, revoke and rotate a public link independently of team visibility", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await createSession();
      const published = await setPublic(true);
      expect(published?.[0]).toBe(true);
      const result = Value.Decode(SessionPublicShareSetResultSchema, published?.[1]);
      const firstGrant = expectDefined(
        loadSessionEntry(scope)?.publicShare,
        "persisted public share grant",
      );
      expect(result.publicShare).toEqual({
        token: expect.stringMatching(/^v1\.[A-Za-z0-9_-]+$/u),
        createdAt: firstGrant.createdAt,
      });
      expect(resolvePublicSessionShareToken(result.publicShare?.token ?? "")).toEqual({
        ...scope,
        sessionId,
        shareId: firstGrant.id,
      });
      expect(isSecretValueRegisteredForRedaction(result.publicShare?.token ?? "")).toBe(true);
      expect(isSecretValueRegisteredForRedaction(firstGrant.id)).toBe(true);
      expect(loadSessionEntry(scope)?.visibility).toBeUndefined();

      const repeated = await setPublic(true);
      const repeatedResult = Value.Decode(SessionPublicShareSetResultSchema, repeated?.[1]);
      expect(repeatedResult.publicShare?.token).not.toBe(result.publicShare?.token);
      expect(repeatedResult.publicShare?.createdAt).toBe(result.publicShare?.createdAt);
      const listed = await call("session.members.listEvidence", scope);
      const listedShare = Value.Decode(
        SessionMembersListEvidenceResultSchema,
        listed?.[1],
      ).publicShare;
      expect(listedShare?.createdAt).toBe(result.publicShare?.createdAt);
      expect(resolvePublicSessionShareToken(listedShare?.token ?? "")).toEqual({
        ...scope,
        sessionId,
        shareId: firstGrant.id,
      });
      expect(projectPublicSessionEntry(loadSessionEntry(scope)!)).not.toHaveProperty("publicShare");

      expect((await setPublic(false))?.[0]).toBe(true);
      expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
      const firstGrantId = firstGrant.id;
      const republished = Value.Decode(
        SessionPublicShareSetResultSchema,
        (await setPublic(true))?.[1],
      );
      const republishedGrant = expectDefined(
        loadSessionEntry(scope)?.publicShare,
        "republished public share grant",
      );
      expect(republishedGrant.id).not.toBe(firstGrantId);
      expect(resolvePublicSessionShareToken(republished.publicShare?.token ?? "")?.shareId).toBe(
        republishedGrant.id,
      );
    });
  });

  it("rejects non-managers and stale generation confirmations without changing publication", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await createSession();
      expect((await setPublic(true, identifiedClient("outsider")))?.[0]).toBe(false);
      expect((await setPublic(true, undefined, "previous-generation"))?.[0]).toBe(false);
      expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
      const admin = identifiedClient("admin");
      admin.connect.scopes = ["operator.admin"];
      expect((await setPublic(true, admin))?.[0]).toBe(true);
      const publication = loadSessionEntry(scope)?.publicShare;
      expect((await setPublic(false, identifiedClient("outsider")))?.[0]).toBe(false);
      expect(loadSessionEntry(scope)?.publicShare).toEqual(publication);
    });
  });

  it("rejects publication when runtime config remaps the exact store before commit", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "global";
      const firstStorePath = state.path("public-share-first.sqlite");
      const secondStorePath = state.path("public-share-second.sqlite");
      const entry = {
        sessionId,
        updatedAt: 1,
        createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath: firstStorePath },
        entry,
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath: secondStorePath },
        entry,
      );
      const configFor = (store: string) => ({
        session: { scope: "global" as const, store },
        agents: {
          ownership: "explicit" as const,
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {} },
        },
      });
      const firstConfig = configFor(firstStorePath);
      const secondConfig = configFor(secondStorePath);
      let configReads = 0;
      const requestContext = sessionSharingTestContext(vi.fn(), firstConfig);
      requestContext.getRuntimeConfig = () => (++configReads <= 2 ? firstConfig : secondConfig);
      const admin = identifiedClient("admin");
      admin.connect.scopes = ["operator.admin"];
      const responses: Parameters<RespondFn>[] = [];

      await expect(
        expectDefined(
          sessionSharingHandlers["session.publicShare.set"],
          "sharing handler",
        )({
          params: { sessionKey, expectedSessionId: sessionId, enabled: true },
          client: admin,
          context: requestContext,
          respond: (...response: Parameters<RespondFn>) => responses.push(response),
        } as never),
      ).rejects.toThrow("session changed before sharing mutation");

      expect(responses).toEqual([]);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath: firstStorePath })?.publicShare,
      ).toBeUndefined();
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath: secondStorePath })?.publicShare,
      ).toBeUndefined();
    });
  });

  it("rejects an unencodable locator before persisting its publication grant", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const oversizedScope = {
        agentId: "main",
        sessionKey: `agent:main:${"🙂".repeat(2_000)}`,
      };
      await upsertSessionEntryCore(oversizedScope, {
        sessionId,
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "owner" },
      });

      await expect(
        call("session.publicShare.set", {
          ...oversizedScope,
          expectedSessionId: sessionId,
          enabled: true,
        }),
      ).rejects.toThrow("public session locator exceeds the maximum length");
      expect(loadSessionEntry(oversizedScope)?.publicShare).toBeUndefined();
    });
  });

  it("drops publication at the canonical writer when resetting or copying into a fork", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await createSession();
      await setPublic(true);
      const original = loadSessionEntry(scope)!;
      const forkScope = { ...scope, sessionKey: "agent:main:public-example-fork" };
      await upsertSessionEntryCore(forkScope, { ...original, sessionId: "fork-generation" });
      expect(loadSessionEntry(forkScope)?.publicShare).toBeUndefined();
      expect(loadSessionEntry(scope)?.publicShare).toEqual(original.publicShare);
      await patchSessionEntryCore(scope, () => ({ sessionId: "reset-generation" }));
      expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
      expect((await setPublic(true))?.[0]).toBe(false);
      expect((await setPublic(true, undefined, "reset-generation"))?.[0]).toBe(true);
      await patchSessionEntryCore(scope, () => ({ incognito: true }));
      expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
      await patchSessionEntryCore(scope, () => ({ incognito: undefined }));
      expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
    });
  });
});
