import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  clearUserProfileAuthLink,
  listUserProfileAuthLinks,
} from "../../state/user-model-accounts.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  connectChatMetadataAccount,
  createDraftChatMetadataScope,
  createPersonalChatMetadataFixture,
} from "./chat-metadata-runtime.test-support.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "./models-list-result.openai-routes.test-support.js";

describe("gateway chat metadata personal accounts", () => {
  test.each(["metadata", "startup"] as const)(
    "keeps persisted-session %s separate from personal defaults and draft previews",
    async (surface) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "personal-chat-metadata-", env: WITHOUT_OPENAI_ENV_AUTH },
        async () => {
          const { harness, owner, alice, bob, aliceScope, bobScope } =
            await createPersonalChatMetadataFixture();
          const shared = await harness.runtime.read({ agentId: "main" });
          expect(await harness.runtime.read(aliceScope)).toEqual(shared);
          const aliceAuthId = connectChatMetadataAccount(alice.id);
          const available = {
            models: expect.arrayContaining([
              expect.objectContaining({ id: "gpt-5.6-luna", available: true }),
            ]),
          };
          await expect(harness.runtime.read(aliceScope)).resolves.toMatchObject(available);
          for (const selector of [
            { sessionKey: "agent:main:existing", sessionEntry: { sessionId: randomUUID() } },
            { sessionKey: "agent:main:missing" },
            { sessionEntry: { sessionId: randomUUID() } },
          ]) {
            const request = { ...aliceScope, ...selector };
            const metadata =
              surface === "metadata"
                ? await harness.runtime.read(request)
                : (await harness.runtime.readStartup(request))?.metadata;
            expect(metadata).toEqual(shared);
          }
          expect(await harness.runtime.read(bobScope)).toEqual(shared);
          expect(await harness.runtime.read({ agentId: "main" })).toEqual(shared);

          const pinned = {
            ...bobScope,
            sessionEntry: {
              authProfileOverride: aliceAuthId,
              authProfileOverrideSource: "user-link" as const,
            },
          };
          await expect(harness.runtime.readStartup(pinned)).resolves.toMatchObject({
            metadata: available,
          });
          expect((await harness.runtime.read(pinned)).accountSelection).toEqual({
            kind: "personal",
            label: "Alice's account",
            source: "user-link",
          });
          const ownerView = await harness.runtime.readStartup({
            ...pinned,
            requesterProfileId: alice.id,
          });
          expect(ownerView?.metadata?.accountSelection).toEqual({
            kind: "personal",
            label: "Private provider account",
            authProfileId: aliceAuthId,
            source: "user-link",
          });
          clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });
          expect(await harness.runtime.read(aliceScope)).toEqual(shared);
          await expect(
            harness.runtime.read(createDraftChatMetadataScope(alice.id, aliceAuthId).params),
          ).resolves.toMatchObject({
            ...available,
            accountSelection: { kind: "personal", authProfileId: aliceAuthId, source: "user" },
          });
          expect(listUserProfileAuthLinks(alice.id)).toEqual([]);
          await expect(harness.runtime.readStartup(pinned)).resolves.toMatchObject({
            metadata: available,
          });

          connectChatMetadataAccount(bob.id);
          await expect(
            harness.runtime.read({
              ...pinned,
              sessionEntry: {
                ...pinned.sessionEntry,
                authProfileOverride: `personal:${alice.id}:${randomUUID()}`,
              },
            }),
          ).resolves.toMatchObject({
            models: [expect.objectContaining({ available: false })],
          });
          expect(harness.getPreparedAuthStore()?.profiles).toEqual({});
          expect(owner.authModes).toEqual({});
        },
      );
    },
  );

  test.each(["user", "user-link"] as const)(
    "keeps a %s personal session pin available outside shared auth order",
    async (source) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "personal-pinned-metadata-", env: WITHOUT_OPENAI_ENV_AUTH },
        async () => {
          const { harness, owner, alice, bobScope } = await createPersonalChatMetadataFixture();
          const authProfileId = connectChatMetadataAccount(alice.id);
          const config = { ...owner.config, auth: { order: { openai: ["openai:shared"] } } };
          harness.setConfig(config);
          harness.setOwner({ ...owner, config });
          await harness.runtime.refresh();
          const request = {
            ...bobScope,
            sessionEntry: {
              authProfileOverride: authProfileId,
              authProfileOverrideSource: source,
            },
          };
          const available = {
            models: expect.arrayContaining([
              expect.objectContaining({ id: "gpt-5.6-luna", available: true }),
            ]),
          };
          await expect(harness.runtime.read(request)).resolves.toMatchObject(available);
          await expect(harness.runtime.readStartup(request)).resolves.toMatchObject({
            metadata: available,
          });
          expect(harness.getPreparedAuthStore()?.profiles).toEqual({});
        },
      );
    },
  );
});
