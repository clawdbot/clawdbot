import { describe, expect, it } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
  SkillsLibrarySaveParams,
} from "../../../../packages/gateway-protocol/src/schema/skill-library.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  createSkillLibraryWireInstance,
  decodedSkillLibraryFiles,
  SKILL_LIBRARY_ALICE,
  SKILL_LIBRARY_BOB,
  SKILL_LIBRARY_WRITER_SCOPES,
  SkillLibraryWireClient,
} from "./skill-library-wire-fixture.js";

function skillLibraryProofBundle(reference = "alice-reference-v1\n"): SkillsLibrarySaveParams {
  return {
    expectedRevision: null,
    slug: "boundary-proof",
    content:
      "---\nname: boundary-proof\ndescription: Synthetic library boundary proof.\n---\nRead references/value.txt and run scripts/report.mjs beside this SKILL.md.\n",
    files: [
      { path: "references/value.txt", content: reference },
      {
        path: "scripts/report.mjs",
        content: "console.log('synthetic helper');\n",
        executable: true,
      },
      { path: "references/binary.dat", content: "AAEC/w==", encoding: "base64" },
    ],
  };
}

async function expectLibraryError(operation: Promise<unknown>, code: string, extra = {}) {
  await expect(operation).rejects.toMatchObject({
    error: { code: "INVALID_REQUEST", details: { code: `SKILL_LIBRARY_${code}`, ...extra } },
  });
}

describe("skill library real Gateway identity boundary", () => {
  it(
    "keeps solo defaults, isolates authenticated libraries, and publishes complete optimistic revisions",
    {
      timeout: 180_000,
    },
    async () => {
      const instance = await createSkillLibraryWireInstance();
      const clients: SkillLibraryWireClient[] = [];
      await runQaGatewayFixture(
        async () => {
          await instance.startGateway();
          const connect = async (
            options?: Parameters<typeof SkillLibraryWireClient.connect>[1],
          ) => {
            const connected = await SkillLibraryWireClient.connect(instance, options);
            clients.push(connected.client);
            return connected;
          };
          const { client: localAdmin, hello: adminHello } = await connect();
          expect(adminHello.auth?.scopes).toContain("operator.admin");
          const list = (client: SkillLibraryWireClient) =>
            client.request<SkillsLibraryListResult>("skills.library.list", {});
          await expect(list(localAdmin)).resolves.toMatchObject({
            profileId: null,
            multipleProfiles: false,
            defaultTarget: "workspace",
            canManageWorkspace: true,
          });
          // Multiple real anonymous operator connections must not masquerade as multiple people.
          const { client: otherAnonymous } = await connect();
          await expect(list(otherAnonymous)).resolves.toMatchObject({
            multipleProfiles: false,
            defaultTarget: "workspace",
          });
          await expectLibraryError(
            localAdmin.request("skills.library.save", skillLibraryProofBundle()),
            "IDENTITY_REQUIRED",
          );

          const { client: aliceAdmin, hello: aliceAdminHello } = await connect({
            email: SKILL_LIBRARY_ALICE,
            scopes: ["operator.admin", ...SKILL_LIBRARY_WRITER_SCOPES],
            buildId: adminHello.server.buildId,
          });
          expect(aliceAdminHello.auth?.scopes).toContain("operator.admin");
          const solo = await list(aliceAdmin);
          expect(solo.profileId).toEqual(expect.any(String));
          expect(solo).toMatchObject({ multipleProfiles: false, defaultTarget: "workspace" });
          expect(solo.defaultSelectionLimit).toBe(64);
          expect(solo.defaultSelectionNotice).toBeUndefined();

          const { client: alice, hello: aliceHello } = await connect({
            email: SKILL_LIBRARY_ALICE,
            buildId: adminHello.server.buildId,
          });
          const { client: bob, hello: bobHello } = await connect({
            email: SKILL_LIBRARY_BOB,
            buildId: adminHello.server.buildId,
          });
          for (const hello of [aliceHello, bobHello]) {
            expect(hello.auth?.scopes?.toSorted()).toEqual(
              [...SKILL_LIBRARY_WRITER_SCOPES].toSorted(),
            );
          }
          const aliceList = await list(alice);
          const bobList = await list(bob);
          expect(aliceList).toMatchObject({
            profileId: solo.profileId,
            multipleProfiles: true,
            defaultTarget: "personal",
            canManageWorkspace: false,
          });
          expect(bobList).toMatchObject({
            multipleProfiles: true,
            defaultTarget: "personal",
            canManageWorkspace: false,
          });
          expect(bobList.profileId).toEqual(expect.any(String));
          expect(bobList.profileId).not.toBe(aliceList.profileId);
          const self = await alice.request<{ profile: { id: string } }>("users.self", {});
          expect(self.profile.id).toBe(aliceList.profileId);
          const profiles = await localAdmin.request<{ profiles: Array<{ id: string }> }>(
            "users.list",
            {},
          );
          expect(profiles.profiles.map((profile) => profile.id).toSorted()).toEqual(
            [aliceList.profileId, bobList.profileId].toSorted(),
          );

          const original = skillLibraryProofBundle();
          const created = await alice.request<SkillsLibraryReceipt>(
            "skills.library.save",
            original,
          );
          expect(created).toMatchObject({
            state: "published",
            target: "personal",
            sessionActivation: "new-sessions",
            entry: {
              ownerProfileId: aliceList.profileId,
              authorProfileId: aliceList.profileId,
              shared: false,
              canEdit: true,
            },
          });
          expect(created.nextAction).toEqual(expect.any(String));
          expect(created.nextAction.length).toBeGreaterThan(0);
          expect(created.entry.revision).toMatch(/^[a-f0-9]{64}$/u);
          expect(created.entry.ownerLabel.trim().length).toBeGreaterThan(0);
          expect(created.entry.name).toMatch(/^s_boundary_[a-f0-9]{20}$/u);
          expect(created.entry.name.length).toBeLessThanOrEqual(32);
          const bobOwn = await bob.request<SkillsLibraryReceipt>("skills.library.save", {
            ...original,
            content: original.content.replace("Synthetic library", "Bob private library"),
          });
          expect(bobOwn.entry.skillId).not.toBe(created.entry.skillId);
          expect(bobOwn.entry.name).not.toBe(created.entry.name);
          const read = (client: SkillLibraryWireClient, skillId: string, revision?: string) =>
            client.request<SkillsLibraryReadResult>("skills.library.read", {
              skillId,
              ...(revision ? { revision } : {}),
            });

          // Guessing an existing ID, including its known revision, grants no private access.
          for (const [reader, privateEntry] of [
            [bob, created.entry],
            [alice, bobOwn.entry],
          ] as const) {
            expect((await list(reader)).entries.map((entry) => entry.skillId)).not.toContain(
              privateEntry.skillId,
            );
            await expectLibraryError(read(reader, privateEntry.skillId), "NOT_FOUND");
            await expectLibraryError(
              read(reader, privateEntry.skillId, privateEntry.revision),
              "NOT_FOUND",
            );
            await expectLibraryError(
              reader.request("skills.library.save", {
                ...original,
                skillId: privateEntry.skillId,
                expectedRevision: privateEntry.revision,
              }),
              "NOT_FOUND",
            );
            await expectLibraryError(
              reader.request("skills.library.mutate", {
                skillId: privateEntry.skillId,
                expectedRevision: privateEntry.revision,
                action: "remove",
              }),
              "NOT_FOUND",
            );
          }

          const initial = await read(alice, created.entry.skillId);
          expect(initial.content).toBe(original.content);
          expect(decodedSkillLibraryFiles(initial.files)).toEqual(
            decodedSkillLibraryFiles(original.files!),
          );
          const edited = skillLibraryProofBundle("alice-reference-v2\n");
          const updated = await alice.request<SkillsLibraryReceipt>("skills.library.save", {
            ...edited,
            skillId: created.entry.skillId,
            expectedRevision: created.entry.revision,
          });
          expect(updated.state).toBe("published");
          expect(updated.entry.revision).not.toBe(created.entry.revision);
          expect(updated.sessionActivation).toBe("new-sessions");
          await expectLibraryError(
            alice.request("skills.library.save", {
              ...original,
              skillId: created.entry.skillId,
              expectedRevision: created.entry.revision,
              content: original.content + "Stale destructive edit.\n",
            }),
            "CONFLICT",
            { currentRevision: updated.entry.revision },
          );
          const current = await read(alice, created.entry.skillId);
          expect(current.content).toBe(original.content);
          expect(decodedSkillLibraryFiles(current.files)).toEqual(
            decodedSkillLibraryFiles(edited.files!),
          );
          expect(current.revisions.map((item) => item.revision).toSorted()).toEqual(
            [created.entry.revision, updated.entry.revision].toSorted(),
          );
          const old = await read(alice, created.entry.skillId, created.entry.revision);
          expect(old.content).toBe(original.content);
          expect(decodedSkillLibraryFiles(old.files)).toEqual(
            decodedSkillLibraryFiles(original.files!),
          );
          const unchanged = await alice.request<SkillsLibraryReceipt>("skills.library.save", {
            ...edited,
            skillId: created.entry.skillId,
            expectedRevision: updated.entry.revision,
            files: [...current.files].reverse(),
          });
          expect(unchanged).toMatchObject({
            state: "unchanged",
            entry: { revision: updated.entry.revision, updatedAt: updated.entry.updatedAt },
          });
          expect((await read(alice, created.entry.skillId)).revisions).toEqual(current.revisions);

          await alice.request("skills.library.mutate", {
            skillId: created.entry.skillId,
            expectedRevision: updated.entry.revision,
            action: "share",
          });
          expect((await read(bob, created.entry.skillId)).entry).toMatchObject({
            shared: true,
            canEdit: false,
            ownerProfileId: aliceList.profileId,
          });
          await expectLibraryError(
            bob.request("skills.library.save", {
              ...edited,
              skillId: created.entry.skillId,
              expectedRevision: updated.entry.revision,
            }),
            "FORBIDDEN",
          );
          for (const action of ["unshare", "remove", "rollback", "transfer"] as const) {
            await expectLibraryError(
              bob.request("skills.library.mutate", {
                skillId: created.entry.skillId,
                expectedRevision: updated.entry.revision,
                action,
                ...(action === "rollback" ? { revision: created.entry.revision } : {}),
              }),
              "FORBIDDEN",
            );
          }
          // Even the owner cannot self-promote a skill into team ownership on a capped connection.
          await expectLibraryError(
            alice.request("skills.library.mutate", {
              skillId: created.entry.skillId,
              expectedRevision: updated.entry.revision,
              action: "transfer",
            }),
            "FORBIDDEN",
          );
          const transferred = await aliceAdmin.request<SkillsLibraryReceipt>(
            "skills.library.mutate",
            {
              skillId: created.entry.skillId,
              expectedRevision: updated.entry.revision,
              action: "transfer",
            },
          );
          expect(transferred).toMatchObject({
            target: "team",
            entry: {
              skillId: created.entry.skillId,
              revision: updated.entry.revision,
              ownerProfileId: null,
              authorProfileId: aliceList.profileId,
              shared: true,
            },
          });
          const teamRead = await read(bob, created.entry.skillId);
          expect(teamRead.entry.canEdit).toBe(false);
          expect(teamRead.content).toBe(original.content);
          expect(decodedSkillLibraryFiles(teamRead.files)).toEqual(
            decodedSkillLibraryFiles(edited.files!),
          );
          await expectLibraryError(
            alice.request("skills.library.mutate", {
              skillId: created.entry.skillId,
              expectedRevision: updated.entry.revision,
              action: "remove",
            }),
            "FORBIDDEN",
          );
        },
        async () => {
          for (const client of clients.reverse()) {
            await client.close();
          }
        },
        () => instance.cleanup(),
      );
    },
  );
});
