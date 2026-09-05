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
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import { identifiedClient, sessionSharingTestContext } from "./sessions-sharing.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

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
      expect(result.publicShare?.sessionId).toBe(sessionId);
      expect(loadSessionEntry(scope)?.visibility).toBeUndefined();

      const repeated = await setPublic(true);
      expect(repeated?.[1]).toEqual(result);
      const listed = await call("session.members.listEvidence", scope);
      expect(Value.Decode(SessionMembersListEvidenceResultSchema, listed?.[1]).publicShare).toEqual(
        result.publicShare,
      );
      expect(projectPublicSessionEntry(loadSessionEntry(scope)!)).not.toHaveProperty("publicShare");

      expect((await setPublic(false))?.[0]).toBe(true);
      expect(loadSessionEntry(scope)?.publicShare).toBeUndefined();
      const republished = Value.Decode(
        SessionPublicShareSetResultSchema,
        (await setPublic(true))?.[1],
      );
      expect(republished.publicShare?.id).not.toBe(result.publicShare?.id);
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
