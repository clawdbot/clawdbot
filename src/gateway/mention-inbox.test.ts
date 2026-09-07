import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateMentionsListResult,
  validateUsersMentionableResult,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  linkEmail,
  setDisplayName,
  setUserProfileRole,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createMentionInbox } from "./mention-inbox.js";
import type { MentionCommittedInput, MentionInbox } from "./mention-inbox.types.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { mentionHandlers } from "./server-methods/mentions.js";
import { identifiedClient, soloClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { usersMentionableHandlers } from "./server-methods/users-mentionable.js";

const SESSION_KEY = "agent:main:dashboard:mention-test";
const SESSION_ID = "mention-test-session";
const handlers = { ...mentionHandlers, ...usersMentionableHandlers };
type InboxFixtureOptions = { notifications?: boolean; beforeInbox?: () => void };

afterEach(() => vi.useRealTimers());

async function withInbox(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  cfg: OpenClawConfig = {},
  options: InboxFixtureOptions = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = await createFixture(cfg, options);
    try {
      await run(fixture);
    } finally {
      fixture.dispose();
      vi.useRealTimers();
    }
  });
}

async function createFixture(cfg: OpenClawConfig, options: InboxFixtureOptions) {
  const alice = ensureProfileForEmail("alice@mentions.example.test");
  const bob = ensureProfileForEmail("bob@mentions.example.test");
  const carol = ensureProfileForEmail("carol@mentions.example.test");
  setDisplayName(alice.id, "Alice");
  setDisplayName(bob.id, "Bob");
  setDisplayName(carol.id, "Carol");
  const aliceClient = { ...identifiedClient(alice.id, "Alice"), connId: "alice" };
  const bobClient = { ...identifiedClient(bob.id, "Bob"), connId: "bob-one" };
  const bobSecond = { ...identifiedClient(bob.id, "Bob"), connId: "bob-two" };
  const carolClient = { ...identifiedClient(carol.id, "Carol"), connId: "carol" };
  const clients: GatewayClient[] = [aliceClient, bobClient, bobSecond, carolClient];
  const broadcast = vi.fn();
  const push = vi.fn<NonNullable<Parameters<typeof createMentionInbox>[0]["onMentionCreated"]>>();
  const setSession = (entry: Partial<SessionEntry>, sessionKey = SESSION_KEY) =>
    upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: SESSION_ID,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: alice.id },
        ...entry,
      },
    );
  await setSession({ displayName: "Design review" });
  const inboxes = new Set<MentionInbox>();
  const openInbox = (gatewayInstanceId = "mention-gateway") => {
    const inbox = createMentionInbox({
      gatewayInstanceId,
      getRuntimeConfig: () => cfg,
      getClients: () => clients,
      broadcastToConnIds: broadcast,
      onMentionCreated: options.notifications === false ? undefined : push,
    });
    inboxes.add(inbox);
    return inbox;
  };
  options.beforeInbox?.();
  const inbox = openInbox();
  const context = { mentionInbox: inbox } as GatewayRequestContext;
  async function call(method: string, params: Record<string, unknown>, client = bobClient) {
    let response: { ok: boolean; payload?: unknown; error?: ErrorShape } | undefined;
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Missing test method ${method}`);
    }
    await handler({
      req: { type: "req", id: "mention-test", method, params },
      client,
      params,
      context,
      isWebchatConnect: () => true,
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });
    if (!response) {
      throw new Error(`${method} did not respond`);
    }
    return response;
  }
  return {
    alice,
    bob,
    carol,
    aliceClient,
    bobClient,
    bobSecond,
    carolClient,
    clients,
    inbox,
    call,
    broadcast,
    push,
    setSession,
    openInbox,
    dispose() {
      for (const instance of inboxes) {
        instance.dispose();
      }
    },
    post(sourceId = "source-one", overrides: Partial<MentionCommittedInput> = {}, target = inbox) {
      target.recordCommittedInput({
        sourceId,
        sessionKey: SESSION_KEY,
        agentId: "main",
        sessionId: SESSION_ID,
        messageId: `message-${sourceId}`,
        senderProfileId: alice.id,
        recipientProfileIds: [bob.id],
        excerpt: "@Bob review **this change**",
        ...overrides,
      });
    },
  };
}

function read(inbox: MentionInbox, client: GatewayClient) {
  const result = inbox.list(client);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  expect(validateMentionsListResult(result.value)).toBe(true);
  return result.value;
}

describe("temporary human mention Inbox", () => {
  it("retains original ids, order, and expiry across Gateway restart without replaying push", async () => {
    await withInbox(async (f) => {
      vi.useFakeTimers();
      f.post("first");
      await vi.advanceTimersByTimeAsync(1_000);
      f.post("second");
      const retained = read(f.inbox, f.bobClient).items;
      expect(retained.map((item) => item.messageId)).toEqual(["message-second", "message-first"]);
      f.inbox.dispose();
      f.push.mockClear();
      await vi.advanceTimersByTimeAsync(6 * 24 * 60 * 60_000);
      const restarted = f.openInbox("restarted-gateway");

      expect(read(restarted, f.bobClient)).toMatchObject({
        gatewayInstanceId: "restarted-gateway",
        items: retained,
      });
      f.post("first", {}, restarted);
      f.post("second", {}, restarted);
      expect(f.push).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 1_000);
      expect(read(restarted, f.bobClient).items).toEqual([retained[0]]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(read(restarted, f.bobClient).items).toEqual([]);
    });
  });

  it.each(["normal", "transient failure", "dispose after failure"] as const)(
    "restarts expiry cleanup without a connected client or an Inbox read (%s)",
    async (scenario) => {
      await withInbox(async (f) => {
        vi.useFakeTimers();
        f.clients.length = 0;
        const { db } = openOpenClawStateDatabase();
        const storedSources = () =>
          db
            .prepare(
              "SELECT state_key FROM config_machine_state WHERE state_key GLOB 'notifications.mentions.source.*'",
            )
            .all();
        f.post("original-deadline");
        expect(storedSources()).toHaveLength(1);
        f.inbox.dispose();
        await vi.advanceTimersByTimeAsync(6 * 24 * 60 * 60_000);
        const restarted = f.openInbox("restarted-gateway");
        expect(storedSources()).toHaveLength(1);
        if (scenario !== "normal") {
          db.exec(`CREATE TEMP TRIGGER reject_mention_expiry BEFORE DELETE ON config_machine_state
            WHEN OLD.state_key GLOB 'notifications.mentions.source.*'
            BEGIN SELECT RAISE(ABORT, 'synthetic mention expiry failure'); END`);
        }
        try {
          await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
          expect(storedSources()).toHaveLength(scenario === "normal" ? 0 : 1);
        } finally {
          if (scenario !== "normal") {
            db.exec("DROP TRIGGER reject_mention_expiry");
          }
        }
        if (scenario !== "normal") {
          if (scenario === "dispose after failure") {
            restarted.dispose();
          }
          await vi.advanceTimersByTimeAsync(60_000);
          expect(storedSources()).toHaveLength(scenario === "dispose after failure" ? 1 : 0);
          if (scenario === "dispose after failure") {
            f.openInbox("next-gateway");
            expect(storedSources()).toEqual([]);
          }
        }
        expect(f.push).toHaveBeenCalledTimes(1);
      });
    },
  );

  it("keeps dismissed and evicted sources consumed across restart", async () => {
    await withInbox(async (f) => {
      f.clients.length = 0;
      for (let index = 0; index < 101; index++) {
        f.post(`retained-${index}`);
      }
      const retained = read(f.inbox, f.bobClient).items;
      expect(retained).toHaveLength(100);
      expect(retained.at(-1)?.messageId).toBe("message-retained-1");
      expect(f.inbox.dismiss(f.bobClient, [retained[0]!.id]).ok).toBe(true);
      const expected = retained.slice(1);
      f.inbox.dispose();
      f.push.mockClear();
      const restarted = f.openInbox("restarted-gateway");

      expect(read(restarted, f.bobClient).items).toEqual(expected);
      for (const source of ["retained-0", "retained-100", "retained-50"]) {
        f.post(source, {}, restarted);
      }
      expect(read(restarted, f.bobClient).items).toEqual(expected);
      expect(f.push).not.toHaveBeenCalled();
    });
  });

  it("merges alternating owners' writes without resurrecting dismissals or losing new input", async () => {
    await withInbox(async (f) => {
      vi.useFakeTimers();
      f.post("first");
      const first = read(f.inbox, f.bobClient).items[0]!;
      const peer = f.openInbox("peer-gateway");
      expect(read(peer, f.bobClient).items).toEqual([first]);
      expect(f.inbox.dismiss(f.bobClient, [first.id]).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      f.post("second", {}, peer);
      const second = read(peer, f.bobClient).items[0]!;
      expect(read(f.inbox, f.bobClient).items).toEqual([second]);
      await vi.advanceTimersByTimeAsync(1);
      f.post("third");
      const both = read(f.inbox, f.bobClient).items;
      expect(both.map((item) => item.messageId)).toEqual(["message-third", "message-second"]);
      expect(read(peer, f.bobClient).items).toEqual(both);
      expect(peer.dismiss(f.bobClient, [second.id]).ok).toBe(true);
      expect(read(f.inbox, f.bobClient).items).toEqual([both[0]]);
      expect(f.push.mock.calls[0]?.[0].isCurrent()).toBe(false);
      expect(f.push.mock.calls[1]?.[0].isCurrent()).toBe(false);
      f.inbox.dispose();
      peer.dispose();
      f.push.mockClear();
      const restarted = f.openInbox("restarted-gateway");

      f.post("first", {}, restarted);
      f.post("second", {}, restarted);
      expect(read(restarted, f.bobClient).items).toEqual([both[0]]);
      expect(f.push).not.toHaveBeenCalled();
    });
  });

  it("persists entries and dismissal without changing sqlite_schema or user_version", async () => {
    const schema = () => {
      const { db } = openOpenClawStateDatabase();
      return {
        schema: db.prepare("SELECT * FROM sqlite_schema ORDER BY type, name").all(),
        userVersion: db.prepare("PRAGMA user_version").get(),
      };
    };
    let before: ReturnType<typeof schema> | undefined;
    await withInbox(
      async (f) => {
        f.post("dismissed");
        f.post("retained");
        const original = read(f.inbox, f.bobClient).items;
        expect(f.inbox.dismiss(f.bobClient, [original[1]!.id]).ok).toBe(true);
        f.inbox.dispose();
        const restarted = f.openInbox("restarted-gateway");
        expect(read(restarted, f.bobClient).items).toEqual([original[0]]);
        expect(schema()).toEqual(before);
      },
      {},
      { beforeInbox: () => (before = schema()) },
    );
  });

  it.each(["dismissal", "new input"] as const)(
    "retains committed state and withholds push when storage rejects %s",
    async (operation) => {
      await withInbox(async (f) => {
        f.post("original");
        const retained = read(f.inbox, f.bobClient).items;
        const { db } = openOpenClawStateDatabase();
        for (const action of ["INSERT", "UPDATE", "DELETE"]) {
          db.exec(`CREATE TEMP TRIGGER reject_mention_${action} BEFORE ${action} ON config_machine_state
            WHEN ${action === "DELETE" ? "OLD" : "NEW"}.state_key LIKE 'notifications.mentions.%'
            BEGIN SELECT RAISE(ABORT, 'synthetic mention write failure'); END`);
        }
        f.push.mockClear();
        f.broadcast.mockClear();
        try {
          if (operation === "dismissal") {
            expect(f.inbox.dismiss(f.bobClient, [retained[0]!.id])).toMatchObject({
              ok: false,
              error: { code: "UNAVAILABLE" },
            });
          } else {
            expect(() => f.post("retryable-source")).not.toThrow();
          }
          expect(read(f.inbox, f.bobClient).items).toEqual(retained);
          expect(f.push).not.toHaveBeenCalled();
          expect(f.broadcast).not.toHaveBeenCalled();
        } finally {
          for (const action of ["INSERT", "UPDATE", "DELETE"]) {
            db.exec(`DROP TRIGGER reject_mention_${action}`);
          }
        }
        f.inbox.dispose();
        const restarted = f.openInbox("restarted-gateway");
        expect(read(restarted, f.bobClient).items).toEqual(retained);
        if (operation === "dismissal") {
          expect(restarted.dismiss(f.bobClient, [retained[0]!.id]).ok).toBe(true);
          expect(read(restarted, f.bobClient).items).toEqual([]);
        } else {
          f.post("retryable-source", {}, restarted);
          expect(read(restarted, f.bobClient).items).toHaveLength(2);
          expect(f.push).toHaveBeenCalledTimes(1);
        }
      });
    },
  );

  it("targets only the named person, synchronizes dismissal, and does not replay consumed input", async () => {
    await withInbox(async (f) => {
      for (const client of f.clients) {
        read(f.inbox, client);
      }
      f.post();
      const result = await f.call("mentions.list", {});
      expect(result.ok && validateMentionsListResult(result.payload)).toBe(true);
      const first = read(f.inbox, f.bobClient).items[0];
      expect(first).toMatchObject({
        senderProfileId: f.alice.id,
        senderLabel: "Alice",
        sessionTitle: "Design review",
        excerpt: "@Bob review this change",
      });
      expect(read(f.inbox, f.aliceClient).items).toEqual([]);
      expect(read(f.inbox, f.carolClient).items).toEqual([]);
      expect(f.broadcast.mock.calls.map((call) => [...call[2]])).toEqual([
        ["bob-one"],
        ["bob-two"],
      ]);
      expect(f.push.mock.calls[0]?.[0]).toMatchObject({ recipientProfileId: f.bob.id });
      expect(f.push.mock.calls[0]?.[0].isCurrent()).toBe(true);
      if (!first) {
        throw new Error("Recipient did not receive the mention");
      }

      await f.call("mentions.dismiss", { ids: [first.id, "unknown-mention"] }, f.aliceClient);
      expect(read(f.inbox, f.bobClient).items).toHaveLength(1);
      await f.call("mentions.dismiss", { ids: [first.id] });
      expect(read(f.inbox, f.bobSecond).items).toEqual([]);
      expect(f.push.mock.calls[0]?.[0].isCurrent()).toBe(false);
      f.post();
      expect(read(f.inbox, f.bobClient).items).toEqual([]);
      expect(f.push).toHaveBeenCalledTimes(1);
      f.post("source-two");
      expect(read(f.inbox, f.bobClient).items).toHaveLength(1);
      expect(f.push).toHaveBeenCalledTimes(2);
    });
  });

  it("never exposes a recipient selector, a raw identity, or a fabricated successful empty Inbox", async () => {
    await withInbox(async (f) => {
      f.post();
      expect(
        (await f.call("mentions.list", { profileId: f.bob.id }, f.aliceClient)).error?.code,
      ).toBe("INVALID_REQUEST");
      const raw = { ...soloClient(), connId: "raw", authenticatedUserId: f.bob.id };
      expect(f.inbox.list(raw)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(f.inbox.list({ ...f.bobClient, invalidated: true })).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(f.inbox.list({ ...raw, authenticatedGitHubIdentitySync: vi.fn() })).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", retryable: true },
      });
      f.inbox.dispose();
      expect(f.inbox.list(f.bobClient)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      expect(f.inbox.mentionable(f.aliceClient, { sessionKey: SESSION_KEY })).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
      expect(
        f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, [f.bob.id]),
      ).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE" },
      });
    });
  });

  it("keeps view revisions private and retracts a now-hidden session", async () => {
    await withInbox(async (f) => {
      const initial = read(f.inbox, f.bobClient);
      f.post("carol-source", { recipientProfileIds: [f.carol.id] });
      expect(read(f.inbox, f.bobClient).revision).toBe(initial.revision);
      expect(f.broadcast.mock.calls.some((call) => call[2].has("bob-one"))).toBe(false);
      f.post();
      const visible = read(f.inbox, f.bobClient);
      await f.setSession({ visibility: "draft" });
      f.inbox.invalidate();
      const hidden = read(f.inbox, f.bobClient);
      expect(hidden.items).toEqual([]);
      expect(hidden.revision).toBeGreaterThan(visible.revision);
      f.broadcast.mockClear();
      f.post("hidden-source");
      expect(read(f.inbox, f.bobClient).revision).toBe(hidden.revision);
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(f.push.mock.calls[1]?.[0].isCurrent()).toBe(false);
    });
  });

  it.each([true, false])(
    "retains acknowledgement across profile merges and projects current sender labels (dismissed first: %s)",
    async (dismissedFirst) => {
      await withInbox(async (f) => {
        const old = ensureProfileForEmail("bob-old@mentions.example.test");
        const oldClient = { ...identifiedClient(old.id, "Bob"), connId: "old-bob" };
        const recipientProfileIds = dismissedFirst ? [old.id, f.bob.id] : [f.bob.id, old.id];
        f.clients.push(oldClient);
        f.post("two-profiles", { recipientProfileIds });
        const item = read(f.inbox, oldClient).items[0];
        if (!item) {
          throw new Error("Old profile did not receive the mention");
        }
        f.inbox.dismiss(oldClient, [item.id]);
        linkEmail("bob-old@mentions.example.test", f.bob.id);
        await Promise.resolve();
        expect(read(f.inbox, f.bobClient).items).toEqual([]);
        expect(read(f.inbox, oldClient).items).toEqual([]);
        f.post("two-profiles", { recipientProfileIds });
        expect(f.push).toHaveBeenCalledTimes(2);
        f.post("after-merge", { recipientProfileIds });
        expect(read(f.inbox, oldClient).items).toHaveLength(1);
        setDisplayName(f.alice.id, "Alice Updated");
        await Promise.resolve();
        const retained = read(f.inbox, f.bobClient).items;
        expect(retained[0]?.senderLabel).toBe("Alice Updated");
        f.inbox.dispose();
        f.push.mockClear();
        const restarted = f.openInbox("restarted-gateway");

        expect(read(restarted, f.bobClient).items).toEqual(retained);
        expect(read(restarted, oldClient).items).toEqual(retained);
        f.post("two-profiles", { recipientProfileIds }, restarted);
        f.post("after-merge", { recipientProfileIds }, restarted);
        expect(read(restarted, f.bobClient).items).toEqual(retained);
        expect(f.push).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps recipients independent when they share a committed message", async () => {
    await withInbox(async (f) => {
      f.post("shared-source", { recipientProfileIds: [f.bob.id, f.carol.id] });
      const bob = read(f.inbox, f.bobClient).items[0]!;
      const carol = read(f.inbox, f.carolClient).items[0]!;
      expect(bob.id).not.toBe(carol.id);
      bob.excerpt = "Changed by a caller";
      expect(read(f.inbox, f.carolClient).items).toEqual([carol]);
      f.inbox.dismiss(f.bobClient, [bob.id]);
      expect(read(f.inbox, f.bobClient).items).toEqual([]);
      expect(read(f.inbox, f.carolClient).items).toEqual([carol]);
      expect(f.push.mock.calls.map(([notification]) => notification.isCurrent())).toEqual([
        false,
        true,
      ]);
      f.post("shared-source", { recipientProfileIds: [f.bob.id, f.carol.id] });
      expect(f.push).toHaveBeenCalledTimes(2);
    });
  });

  it("rebuilds the merged profile's bound in arrival order without resurrecting evictions", async () => {
    await withInbox(async (f) => {
      f.clients.length = 0;
      const old = ensureProfileForEmail("bob-merged@mentions.example.test");
      for (let index = 0; index < 150; index++) {
        f.post(`merged-${index}`, { recipientProfileIds: [index % 2 ? f.bob.id : old.id] });
      }
      linkEmail("bob-merged@mentions.example.test", f.bob.id);
      await Promise.resolve();
      const retained = read(f.inbox, f.bobClient).items;
      expect(retained.map((item) => item.messageId)).toEqual(
        Array.from({ length: 100 }, (_, index) => `message-merged-${149 - index}`),
      );
      expect(f.push.mock.calls.filter(([notification]) => notification.isCurrent())).toHaveLength(
        100,
      );
      f.post("merged-0", { recipientProfileIds: [old.id] });
      expect(read(f.inbox, f.bobClient).items).toEqual(retained);
      f.inbox.dismiss(
        f.bobClient,
        retained.map((item) => item.id),
      );
      f.post("merged-149");
      expect(read(f.inbox, f.bobClient).items).toEqual([]);
    });
  });

  it.each([
    { rolesEnabled: false, admin: false, visible: true },
    { rolesEnabled: true, admin: false, visible: false },
    { rolesEnabled: true, admin: true, visible: true },
  ])("preserves shared-owner reads: %j", async ({ rolesEnabled, admin, visible }) => {
    const cfg: OpenClawConfig = rolesEnabled
      ? {
          gateway: {
            roles: {
              default: "reader",
              definitions: {
                reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
              },
            },
          },
        }
      : {};
    await withInbox(async (f) => {
      const owner = ensureGatewayOwnerProfile("Owner");
      const client = identifiedClient(owner.id, "Owner");
      client.connect.scopes = [admin ? "operator.admin" : "operator.read"];
      f.post("owner", { recipientProfileIds: [owner.id] });
      expect(read(f.inbox, client).items).toHaveLength(visible ? 1 : 0);
      expect(f.inbox.mentionable(client, { sessionKey: SESSION_KEY }).ok).toBe(visible);
    }, cfg);
  });

  it("fences delayed push preparation on role revocation, session replacement, and disposal", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
            denied: { agents: [], scopes: [], sessions: { others: "none" } },
          },
        },
      },
    };
    await withInbox(async (f) => {
      f.post();
      const delayed = f.push.mock.calls[0]?.[0];
      expect(delayed?.isCurrent()).toBe(true);
      setUserProfileRole(f.bob.id, "denied");
      invalidateOperatorRolePolicy(f.bob.id);
      await Promise.resolve();
      expect(delayed?.isCurrent()).toBe(false);
      expect(f.inbox.list(f.bobClient)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      setUserProfileRole(f.bob.id, "reader");
      invalidateOperatorRolePolicy(f.bob.id);
      await f.setSession({ sessionId: "replacement-session" });
      emitSessionIdentityMutation({
        agentId: "main",
        kind: "replace",
        previous: { sessionId: SESSION_ID, sessionKeys: [SESSION_KEY] },
        current: { sessionId: "replacement-session", sessionKeys: [SESSION_KEY] },
      });
      expect(read(f.inbox, f.bobClient).items).toEqual([]);
      expect(delayed?.isCurrent()).toBe(false);
      f.inbox.dispose();
      expect(delayed?.isCurrent()).toBe(false);
    }, cfg);
  });

  it("caps per-profile retention without forgetting eviction or dismissal deduplication", async () => {
    await withInbox(async (f) => {
      f.clients.length = 0;
      for (let index = 0; index < 101; index++) {
        f.post(`source-${index}`);
      }
      const retained = read(f.inbox, f.bobClient).items;
      expect(retained).toHaveLength(100);
      expect(retained.at(-1)?.messageId).toBe("message-source-1");
      f.post("source-0");
      expect(read(f.inbox, f.bobClient).items).toEqual(retained);
      f.inbox.dismiss(
        f.bobClient,
        retained.map((item) => item.id),
      );
      f.post("source-100");
      expect(read(f.inbox, f.bobClient).items).toEqual([]);
    });
  });

  it("expires on the Gateway clock and does not backfill after a new Gateway lifetime", async () => {
    await withInbox(async (f) => {
      vi.useFakeTimers();
      f.post("first");
      expect(read(f.inbox, f.bobClient).items).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      f.post("second");
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000 - 1_000);
      expect(read(f.inbox, f.bobClient).items.map((item) => item.messageId)).toEqual([
        "message-second",
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(read(f.inbox, f.bobClient).items).toEqual([]);
      f.post("new-deadline");
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60_000);
      expect(read(f.inbox, f.bobClient).items).toEqual([]);
      f.inbox.dispose();
      const replacement = createMentionInbox({
        gatewayInstanceId: "replacement-gateway",
        getRuntimeConfig: () => ({}),
        getClients: () => f.clients,
        broadcastToConnIds: f.broadcast,
      });
      try {
        expect(read(replacement, f.bobClient)).toMatchObject({
          gatewayInstanceId: "replacement-gateway",
          items: [],
        });
      } finally {
        replacement.dispose();
      }
    });
  });

  it("enforces the global bound and keeps evicted sources consumed", async () => {
    await withInbox(
      async (f) => {
        f.clients.length = 0;
        const profiles = Array.from(
          { length: 101 },
          (_, index) => ensureProfileForEmail(`capacity-${index}@mentions.example.test`).id,
        );
        const post = (index: number) =>
          f.post(`source-${index}`, {
            messageId: `message-${index}`,
            excerpt: undefined,
            recipientProfileIds: Array.from(
              { length: 10 },
              (_, offset) => profiles[(index * 10 + offset) % profiles.length]!,
            ),
          });
        for (let index = 0; index < 1_001; index++) {
          post(index);
        }
        const retained = profiles.map((id) => read(f.inbox, identifiedClient(id)));
        expect(retained.reduce((sum, snapshot) => sum + snapshot.items.length, 0)).toBe(10_000);
        const firstRecipient = identifiedClient(profiles[0]!);
        expect(
          read(f.inbox, firstRecipient).items.some((item) => item.messageId === "message-0"),
        ).toBe(false);
        post(0);
        expect(
          read(f.inbox, firstRecipient).items.some((item) => item.messageId === "message-0"),
        ).toBe(false);
      },
      {},
      { notifications: false },
    );
  });

  it("keeps the posted Inbox item if its push adapter throws", async () => {
    await withInbox(async (f) => {
      f.push.mockImplementation(() => {
        throw new Error("synthetic push failure");
      });
      expect(() => f.post()).not.toThrow();
      expect(read(f.inbox, f.bobClient).items).toHaveLength(1);
    });
  });
});

describe("human mention directory", () => {
  it("includes offline people without leaking administrative profile fields or binding raw presence", async () => {
    await withInbox(async (f) => {
      const offline = ensureProfileForEmail("offline@mentions.example.test");
      setDisplayName(offline.id, "Bob");
      f.clients.push({ ...soloClient(), authenticatedUserId: offline.id, connId: "raw-offline" });
      const response = await f.call(
        "users.mentionable",
        { sessionKey: SESSION_KEY, query: "Bob" },
        f.aliceClient,
      );
      expect(response.ok && validateUsersMentionableResult(response.payload)).toBe(true);
      if (!validateUsersMentionableResult(response.payload)) {
        throw new Error("Invalid directory result");
      }
      const users = response.payload.users;
      expect(users.map((user) => [user.profileId, user.online])).toEqual([
        [f.bob.id, true],
        [offline.id, false],
      ]);
      expect(new Set(users.map((user) => user.displayName)).size).toBe(2);
      for (const user of users) {
        expect(Object.keys(user).toSorted()).toEqual([
          "avatarUrl",
          "displayName",
          "online",
          "profileId",
        ]);
      }
      setDisplayName(offline.id, "Dana");
      const renamed = f.inbox.mentionable(f.aliceClient, {
        sessionKey: SESSION_KEY,
        query: "Dana",
      });
      expect(renamed).toMatchObject({
        ok: true,
        value: { users: [{ profileId: offline.id, displayName: "Dana", online: false }] },
      });
    });
  });

  it.each([
    {
      name: "administrator receiving a draft",
      role: "administrator",
      sessionKey: SESSION_KEY,
      entry: { visibility: "draft" },
      visible: true,
      storedSources: 1,
    },
    {
      name: "owner-only recipient of a shared session",
      role: "owner-only",
      sessionKey: SESSION_KEY,
      entry: { visibility: "shared" },
      visible: false,
      storedSources: 1,
    },
    {
      name: "administrator in an entry-flag incognito session",
      role: "administrator",
      sessionKey: "agent:main:dashboard:mention-incognito-flag",
      entry: { visibility: "shared", incognito: true },
      visible: false,
      storedSources: 0,
    },
    {
      name: "administrator in a canonical-key incognito session",
      role: "administrator",
      sessionKey: "agent:main:dashboard:incognito-mention-key",
      entry: { visibility: "shared" },
      visible: false,
      storedSources: 0,
    },
  ] as const)(
    "applies offline recipient policy across directory, admission, and delivery: $name",
    async ({ role, sessionKey, entry, visible, storedSources }) => {
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
              "owner-only": {
                agents: "*",
                scopes: ["operator.read"],
                sessions: { others: "none" },
              },
              administrator: {
                agents: "*",
                scopes: ["operator.admin"],
                sessions: { others: "none" },
              },
            },
          },
        },
      };
      await withInbox(async (f) => {
        setUserProfileRole(f.alice.id, "administrator");
        invalidateOperatorRolePolicy(f.alice.id);
        setUserProfileRole(f.bob.id, role);
        invalidateOperatorRolePolicy(f.bob.id);
        f.aliceClient.connect.scopes = ["operator.admin"];
        f.bobClient.connect.scopes = ["operator.admin"];
        f.clients.length = 0;
        const sessionId = sessionKey === SESSION_KEY ? SESSION_ID : "incognito-policy-session";
        await f.setSession({ sessionId, ...entry }, sessionKey);
        const directory = f.inbox.mentionable(f.aliceClient, { sessionKey, query: "Bob" });
        const admission = f.inbox.validateRecipients(f.aliceClient, { sessionKey }, [f.bob.id]);
        f.post("policy-source", { sessionKey, sessionId });
        expect({
          users: directory.ok && directory.value.users.map((user) => [user.profileId, user.online]),
          accepted: admission.ok,
          inboxKeys: read(f.inbox, f.bobClient).items.map((item) => item.sessionKey),
          pushedRecipients: f.push.mock.calls.map(([mention]) => mention.recipientProfileId),
          storedSources: openOpenClawStateDatabase()
            .db.prepare(
              "SELECT state_key FROM config_machine_state WHERE state_key GLOB 'notifications.mentions.source.*'",
            )
            .all().length,
        }).toEqual({
          users: visible ? [[f.bob.id, false]] : [],
          accepted: visible,
          inboxKeys: visible ? [sessionKey] : [],
          pushedRecipients: visible ? [f.bob.id] : [],
          storedSources,
        });
      }, cfg);
    },
  );

  it("allows a mention draft for a non-owner of the fixed global store", async () => {
    await withInbox(
      async (f) => {
        const draft = { agentId: "ops", query: "Bob" };
        expect(f.inbox.mentionable(f.aliceClient, draft)).toMatchObject({
          ok: true,
          value: { users: [{ profileId: f.bob.id, displayName: "Bob" }] },
        });
        expect(f.inbox.validateRecipients(f.aliceClient, draft, [f.bob.id])).toEqual({
          ok: true,
          value: [f.bob.id],
        });
        expect(read(f.inbox, f.bobClient).items).toEqual([]);
      },
      {
        session: { scope: "global", store: "/synthetic/fixed-global.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, ops: {} },
        },
      },
    );
  });

  it("applies creation and current visibility policy without accepting unavailable recipients", async () => {
    await withInbox(async (f) => {
      expect(f.inbox.mentionable(f.aliceClient, { agentId: "main" })).toMatchObject({
        ok: true,
        value: { truncated: false },
      });
      expect(
        f.inbox.mentionable(f.aliceClient, { agentId: "main", visibility: "draft" }),
      ).toMatchObject({ ok: true, value: { users: [] } });
      expect(f.inbox.mentionable(f.aliceClient, { agentId: "missing" }).ok).toBe(false);
      expect(
        f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, [f.alice.id]).ok,
      ).toBe(false);
      expect(
        f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, ["missing-person"])
          .ok,
      ).toBe(false);
      await f.setSession({ visibility: "draft" });
      const hidden = f.inbox.mentionable(f.bobClient, { sessionKey: SESSION_KEY });
      expect(hidden).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Session was not found." },
      });
      expect(
        f.inbox.validateRecipients(f.aliceClient, { sessionKey: SESSION_KEY }, [f.bob.id]).ok,
      ).toBe(false);
    });
  });

  it("reports truncated results while a narrower search returns the matching offline person", async () => {
    await withInbox(async (f) => {
      for (let index = 0; index < 105; index++) {
        const profile = ensureProfileForEmail(`teammate-${index}@mentions.example.test`);
        setDisplayName(profile.id, `Teammate ${index}`);
      }
      const result = f.inbox.mentionable(f.aliceClient, {
        sessionKey: SESSION_KEY,
        query: "Teammate",
      });
      expect(result.ok && result.value.truncated).toBe(true);
      expect(result.ok && result.value.users.length).toBe(100);
      expect(
        f.inbox.mentionable(f.aliceClient, { sessionKey: SESSION_KEY, query: "Teammate 104" }),
      ).toMatchObject({
        ok: true,
        value: { users: [{ displayName: "Teammate 104", online: false }], truncated: false },
      });
    });
  });
});
