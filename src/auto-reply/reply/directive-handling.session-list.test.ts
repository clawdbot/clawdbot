import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { respondWithCachedSessionList } from "../../gateway/server-methods/sessions-list-cache.js";
import { listSessionFixture } from "../../gateway/session-list.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

it.each([
  { command: "/verbose full", authorized: true, expected: { verboseLevel: "full" } },
  { command: "/reasoning on", authorized: true, expected: { reasoningLevel: "on" } },
  { command: "/fast on", authorized: true, expected: { fastMode: true } },
  { command: "/verbose full", authorized: false, expected: { verboseLevel: "off" } },
])(
  "keeps the cached session list current after $command (authorized=$authorized)",
  async ({ command, authorized, expected }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = {};
      const scope = { agentId: "main", sessionKey: "agent:main:main" };
      const storePath = resolveSessionStorePathCore(undefined, { agentId: scope.agentId });
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      await upsertSessionEntryCore(scope, {
        sessionId: "directive-list",
        updatedAt: 1,
        verboseLevel: "off",
        reasoningLevel: "off",
        fastMode: false,
      });
      const readEntry = () => expectDefined(loadSessionEntryReadOnly(scope), "session entry");
      const requestList = async () => {
        let response: unknown;
        await respondWithCachedSessionList({
          client: null,
          config: cfg,
          context,
          request: {},
          respond: (ok, payload) => {
            expect(ok).toBe(true);
            response = payload;
          },
          run: async () =>
            await listSessionFixture({
              cfg,
              storePath,
              store: { [scope.sessionKey]: readEntry() },
              opts: {},
            }),
        });
        return response;
      };
      const before = await requestList();
      expect(await requestList()).toBe(before);
      const sessionEntry = readEntry();
      await handleDirectiveOnly({
        cfg,
        ...scope,
        storePath,
        sessionEntry,
        sessionStore: { [scope.sessionKey]: sessionEntry },
        directives: parseInlineSessionDirectives(command),
        elevatedEnabled: false,
        elevatedAllowed: false,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        provider: "openai",
        model: "gpt-5.5",
        initialModelLabel: "openai/gpt-5.5",
        formatModelSwitchEvent: (label) => label,
        aliasIndex: { byAlias: new Map(), byKey: new Map() },
        allowedModelKeys: new Set(["openai/gpt-5.5"]),
        allowedModelCatalog: [],
        resetModelOverride: false,
        messageProvider: "telegram",
        commandAuthorized: authorized,
      });
      expect(readEntry()).toMatchObject(expected);
      const after = await requestList();
      expect(after).toMatchObject({ sessions: [expect.objectContaining(expected)] });
      if (authorized) {
        expect(after).not.toBe(before);
      } else {
        expect(after).toBe(before);
      }
      expect(await requestList()).toBe(after);
    });
  },
);
