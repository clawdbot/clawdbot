import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  upsertSessionEntryCore,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { seedSkillLibrarySelection } from "../../skills/library/selection.js";
import { saveSkillLibrary } from "../../skills/library/service.js";
import type { SkillLibraryAuthority } from "../../skills/library/store.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { skillsLibraryHandlers } from "./skills-library.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
const content =
  "---\nname: shared-session\ndescription: Session-pinned private procedure\n---\n# Session procedure\n";

describe("read-only session skill library projection", () => {
  it("exposes exact private pins to a shared-session reader without granting library access or changing selections", async () => {
    const root = temps.make("library-session-projection-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const alice = ensureProfileForEmail("alice@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    const cfg = { agents: { list: [{ id: "main", workspace: path.join(root, "workspace") }] } };
    const actor = (profileId: string): SkillLibraryAuthority => ({
      profileId,
      scopes: ["operator.read", "operator.write"],
      getConfig: () => cfg,
      assertCurrent: () => {},
    });
    const saved = await saveSkillLibrary(actor(alice.id), {
      slug: "alice-procedure",
      content,
      expectedRevision: null,
    });
    const bobSkill = await saveSkillLibrary(actor(bob.id), {
      slug: "bob-procedure",
      content,
      expectedRevision: null,
    });
    const pins = seedSkillLibrarySelection(actor(alice.id));
    const key = "agent:main:library-session";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "library-session",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: alice.id },
        skillLibrarySelections: pins,
      },
    );
    const newer = await saveSkillLibrary(actor(alice.id), {
      skillId: saved.entry.skillId,
      slug: "alice-procedure",
      content: content + "New instructions.\n",
      expectedRevision: saved.entry.revision,
    });
    const call = async (method: string, params: Record<string, unknown>) => {
      const respond = vi.fn();
      await skillsLibraryHandlers[method]!({
        params,
        req: { type: "req", id: "test", method, params },
        client: {
          authenticatedUserProfile: { profileId: bob.id },
          connect: { scopes: ["operator.read", "operator.write"] },
        },
        context: { getRuntimeConfig: () => cfg },
        respond,
      } as unknown as GatewayRequestHandlerOptions);
      return respond.mock.calls[0]!;
    };
    const listed = await call("skills.library.list", { sessionKey: key });
    expect(listed[0]).toBe(true);
    const projection = listed[1] as SkillsLibraryListResult;
    expect(projection.entries.map((entry) => entry.skillId)).toEqual([bobSkill.entry.skillId]);
    expect(projection.session?.selections).toMatchObject([
      {
        skillId: saved.entry.skillId,
        revision: saved.entry.revision,
        slug: "alice-procedure",
        ownerLabel: alice.displayName ?? alice.id,
      },
    ]);
    expect(projection.session?.attachable.map((entry) => entry.skillId)).toEqual([
      bobSkill.entry.skillId,
    ]);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key })?.skillLibrarySelections).toEqual(
      pins,
    );
    expect((await call("skills.library.read", { skillId: saved.entry.skillId }))[0]).toBe(false);
    expect(
      (
        await call("skills.library.read", {
          sessionKey: key,
          skillId: saved.entry.skillId,
          revision: newer.entry.revision,
        })
      )[0],
    ).toBe(false);
    const read = await call("skills.library.read", {
      sessionKey: key,
      skillId: saved.entry.skillId,
      revision: saved.entry.revision,
    });
    expect(read[0]).toBe(true);
    expect(read[1] as SkillsLibraryReadResult).toMatchObject({
      content,
      revisions: [{ revision: saved.entry.revision }],
      entry: { canEdit: false },
    });
    expect((read[1] as SkillsLibraryReadResult).revisions).toHaveLength(1);
    await patchSessionEntryCore({ agentId: "main", sessionKey: key }, () => ({
      visibility: "draft",
    }));
    expect((await call("skills.library.list", { sessionKey: key }))[0]).toBe(false);
  });
});
