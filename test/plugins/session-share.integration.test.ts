import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  SessionCatalogProvider,
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionSharePlugin from "../../extensions/session-share/index.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../src/config/sessions/session-accessor.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import * as githubIdentities from "../../src/state/user-profile-github-identity.js";
import { ensureProfileForEmail, syncGitHubIdentity } from "../../src/state/user-profiles.js";

afterEach(() => vi.restoreAllMocks());

function registerSessionShare(runtime: PluginRuntime, config: OpenClawConfig = {}) {
  const nodeCommands: OpenClawPluginNodeHostCommand[] = [];
  const catalogs: SessionCatalogProvider[] = [];
  sessionSharePlugin.register(
    createTestPluginApi({
      runtime,
      config,
      registerNodeHostCommand: (command) => {
        nodeCommands.push(command);
      },
      registerSessionCatalog: (catalog) => {
        catalogs.push(catalog);
      },
    }),
  );
  const catalog = catalogs.find((entry) => entry.id === "openclaw");
  if (!catalog) {
    throw new Error("Session Share did not register its catalog");
  }
  return { commands: nodeCommands, catalog };
}

type SessionPage = { sessions: SessionCatalogSession[]; nextCursor?: string };
type TranscriptPage = {
  threadId: string;
  items: SessionCatalogTranscriptItem[];
  nextCursor?: string;
};

function commandFixture(groups: string[] = ["Team"]) {
  const config: OpenClawConfig = {
    plugins: { entries: { "session-share": { enabled: true, config: { share: { groups } } } } },
  };
  const runtime = createPluginRuntime();
  runtime.config.current = () => config;
  const commands = registerSessionShare(runtime, config).commands;
  const list = commands.find((command) => command.command === "openclaw.sessions.list.v1")!;
  const read = commands.find((command) => command.command === "openclaw.sessions.read.v1")!;
  return {
    config,
    commands,
    list: async (params: Record<string, unknown> = {}) =>
      JSON.parse(await list.handle(JSON.stringify(params))) as SessionPage,
    read: async (threadId: string, params: Record<string, unknown> = {}) =>
      JSON.parse(await read.handle(JSON.stringify({ threadId, ...params }))) as TranscriptPage,
  };
}

const commands = ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"];
const nativeSession: SessionCatalogSession = {
  threadId: "agent:main:shared",
  name: "Shared session",
  status: "idle",
  archived: false,
  canContinue: false,
  canArchive: false,
  canOpenTerminal: false,
};
const remoteIdentity = {
  type: "remote" as const,
  pluginId: "session-share",
  domain: "source",
  idKind: "github-account",
  id: "4242",
};

function catalogFixture() {
  let config: OpenClawConfig = {};
  const list = vi.fn<PluginRuntime["nodes"]["list"]>().mockResolvedValue({
    nodes: [{ nodeId: "alpha", displayName: " Alpha ", connected: true, commands }],
  });
  const invoke = vi
    .fn<PluginRuntime["nodes"]["invoke"]>()
    .mockImplementation(async ({ command }) =>
      command === commands[0]
        ? { payloadJSON: JSON.stringify({ sessions: [nativeSession] }) }
        : {
            payloadJSON: JSON.stringify({
              threadId: nativeSession.threadId,
              items: [{ type: "userMessage", text: "Published question" }],
            }),
          },
    );
  const runtime = createPluginRuntimeMock({
    config: { current: () => config },
    nodes: { list, invoke },
  });
  const catalog = registerSessionShare(runtime).catalog;
  return {
    catalog,
    list,
    invoke,
    setConfig: (next: OpenClawConfig) => {
      config = next;
    },
  };
}

describe("session-share node commands", () => {
  it("publishes only selected nonprivate native sessions with stable paging and search", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fixture = commandFixture();
      // Keep the tied fixture fresh: subsequent writes prune ancient unarchived sessions.
      const recency = Date.now();
      for (const [key, patch] of [
        [
          "agent:main:alpha",
          { label: "Alpha", category: "Team", updatedAt: recency, color: "blue" },
        ],
        [
          "agent:main:beta",
          { label: "Beta", category: "Team", updatedAt: recency, archivedAt: recency - 1 },
        ],
        ["agent:main:private", { label: "Private", category: "Other", updatedAt: recency + 1 }],
        [
          "agent:main:draft",
          { label: "Draft", category: "Team", visibility: "draft", updatedAt: recency + 1 },
        ],
        [
          "agent:main:incognito",
          { label: "Incognito", category: "Team", incognito: true, updatedAt: recency + 1 },
        ],
        [
          "agent:main:catalog:external",
          { label: "Adopted", category: "Team", updatedAt: recency + 1 },
        ],
      ] as const) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: key },
          { sessionId: key, ...patch },
        );
      }
      const first = await fixture.list({ limit: 1 });
      expect(first.sessions).toEqual([
        expect.objectContaining({
          threadId: "agent:main:alpha",
          name: "Alpha",
          color: "blue",
          status: "idle",
          canContinue: false,
          canArchive: false,
          canOpenTerminal: false,
        }),
      ]);
      expect(first.nextCursor).toBeDefined();
      const older = await fixture.list({ limit: 1, cursor: first.nextCursor });
      expect(older.sessions).toEqual([
        expect.objectContaining({
          threadId: "agent:main:beta",
          archived: true,
          status: "archived",
        }),
      ]);
      expect(older.nextCursor).toBeUndefined();
      expect(
        (await fixture.list({ searchTerm: "ALPHA" })).sessions.map((session) => session.threadId),
      ).toEqual(["agent:main:alpha"]);
      expect(
        (await fixture.list({ searchTerm: "MAIN:BETA" })).sessions.map(
          (session) => session.threadId,
        ),
      ).toEqual(["agent:main:beta"]);
      for (const key of ["private", "draft", "incognito", "catalog:external"]) {
        await expect(fixture.read(`agent:main:${key}`)).rejects.toThrow("not shared");
      }
      await expect(fixture.list({ cursor: "invalid" })).rejects.toThrow();
      await expect(fixture.list({ unexpected: true })).rejects.toThrow("Unknown");
    });
  });

  it("reads real newest-first transcript rows with portable sender and revokes moved sessions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("source@example.test");
      const scope = { agentId: "main", sessionKey: "agent:main:shared", sessionId: "shared" };
      await upsertSessionEntryCore(scope, {
        sessionId: "shared",
        updatedAt: 1,
        label: "Shared",
        category: "Team",
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: {
          role: "user",
          content: "Shared question",
          timestamp: 1,
          __openclaw: { senderIdentity: { type: "profile", id: profile.id } },
        },
      });
      await appendSessionTranscriptMessageByIdentity({
        ...scope,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Shared answer" }],
          timestamp: 2,
        },
      });
      const fixture = commandFixture();
      const first = await fixture.read(scope.sessionKey, { limit: 1 });
      expect(first.items).toEqual([
        expect.objectContaining({ type: "agentMessage", text: "Shared answer" }),
      ]);
      const older = await fixture.read(scope.sessionKey, { limit: 1, cursor: first.nextCursor });
      expect(older.items).toEqual([
        expect.objectContaining({
          type: "userMessage",
          text: "Shared question",
          sender: expect.objectContaining({
            identity: {
              type: "remote",
              pluginId: "session-share",
              domain: "openclaw",
              idKind: "profile",
              id: profile.id,
            },
          }),
        }),
      ]);
      expect((await fixture.list()).sessions[0]?.createdActor?.identity).toEqual(
        older.items[0]?.sender?.identity,
      );
      await upsertSessionEntryCore(scope, { category: "Private" });
      await expect(fixture.read(scope.sessionKey)).rejects.toThrow("not shared");
      expect((await fixture.list()).sessions).toEqual([]);
    });
  });

  it.each([undefined, []])(
    "does not advertise or publish without share groups %j",
    async (groups) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const fixture = commandFixture(groups ?? []);
        if (groups === undefined) {
          fixture.config.plugins = undefined;
        }
        for (const command of fixture.commands) {
          expect(command.isAvailable?.({ config: fixture.config, env: {} })).toBe(false);
        }
        expect((await fixture.list()).sessions).toEqual([]);
        await expect(fixture.read("agent:main:unshared")).rejects.toThrow("not shared");
      });
    },
  );
});

describe("session-share receiver identity integration", () => {
  it.each(["alpha", "beta"])(
    "keeps %s claims remote by default and applies only explicit owner and numeric GitHub links",
    async (nodeId) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const profile = syncGitHubIdentity({
          identity: { accountId: 4242, login: "catalog-person", name: "Catalog Person" },
          authenticationAlias: { kind: "github-login", login: "catalog-person" },
        });
        const fixture = catalogFixture();
        fixture.list.mockResolvedValue({ nodes: [{ nodeId, connected: true, commands }] });
        const hostId = `node:${nodeId}`;
        const namespacedIdentity = { ...remoteIdentity, domain: hostId };
        const identityReads = vi.spyOn(githubIdentities, "selectStoredGitHubIdentities");
        const fullIdentityScans = () =>
          identityReads.mock.calls.filter(([, profileIds]) => profileIds === undefined).length;
        const human = {
          ...nativeSession,
          createdActor: {
            type: "human" as const,
            id: "4242",
            identity: remoteIdentity,
            label: "Remote Person",
          },
        };
        const agent = {
          ...nativeSession,
          threadId: "agent:main:agent",
          createdActor: { type: "agent" as const, id: "assistant", label: "Assistant" },
        };
        const unmatched = {
          ...human,
          threadId: "agent:main:unmatched",
          createdActor: {
            ...human.createdActor,
            id: "9999",
            identity: { ...remoteIdentity, id: "9999" },
          },
        };
        const transcript = {
          threadId: nativeSession.threadId,
          items: [remoteIdentity, remoteIdentity, { ...remoteIdentity, id: "9999" }].map(
            (identity) => ({
              type: "userMessage",
              text: "Question",
              sender: { identity, label: "Remote Person" },
            }),
          ),
        };
        fixture.invoke.mockImplementation(async ({ command }) =>
          command === commands[0] ? { sessions: [human, agent, unmatched] } : transcript,
        );
        const namespacedHuman = {
          ...human,
          createdActor: { ...human.createdActor, identity: namespacedIdentity },
        };
        const namespacedUnmatched = {
          ...unmatched,
          createdActor: {
            ...unmatched.createdActor,
            identity: { ...namespacedIdentity, id: "9999" },
          },
        };
        expect((await fixture.catalog.list({}))[0]?.sessions).toEqual([
          namespacedHuman,
          agent,
          namespacedUnmatched,
        ]);
        expect(
          (await fixture.catalog.read({ hostId, threadId: nativeSession.threadId })).items[0]
            ?.sender?.identity,
        ).toEqual(namespacedIdentity);
        expect(fullIdentityScans()).toBe(0);
        for (const owner of [`profile:${profile.id}`, "github:CATALOG-PERSON"]) {
          fixture.setConfig({
            plugins: {
              entries: { "session-share": { config: { nodes: { [nodeId]: { owner } } } } },
            },
          });
          const rows = (await fixture.catalog.list({}))[0]!.sessions;
          expect(rows[0]).toEqual(namespacedHuman);
          expect(rows[1]?.createdActor).toMatchObject({
            type: "human",
            id: profile.id,
            identity: { type: "profile", id: profile.id },
            label: "Catalog Person",
          });
          expect(rows[2]).toEqual(namespacedUnmatched);
        }
        fixture.setConfig({
          plugins: {
            entries: {
              "session-share": { config: { nodes: { [nodeId]: { linkGitHubIdentities: true } } } },
            },
          },
        });
        identityReads.mockClear();
        const linked = (await fixture.catalog.list({}))[0]!.sessions;
        expect.soft(fullIdentityScans()).toBe(1);
        expect(linked[0]?.createdActor).toMatchObject({
          type: "human",
          id: profile.id,
          identity: { type: "profile", id: profile.id },
          label: "Catalog Person",
        });
        expect(linked[1]).toEqual(agent);
        expect(linked[2]).toEqual(namespacedUnmatched);
        identityReads.mockClear();
        const page = await fixture.catalog.read({
          hostId,
          threadId: nativeSession.threadId,
        });
        expect.soft(fullIdentityScans()).toBe(1);
        expect(page.items.map((item) => item.sender)).toEqual([
          { identity: { type: "profile", id: profile.id }, label: "Catalog Person" },
          { identity: { type: "profile", id: profile.id }, label: "Catalog Person" },
          { identity: { ...namespacedIdentity, id: "9999" }, label: "Remote Person" },
        ]);
      });
    },
  );
});
