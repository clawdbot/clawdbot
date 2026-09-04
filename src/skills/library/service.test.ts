import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SKILL_LIBRARY_MAX_FILE_BYTES } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import { materializeSkillResources, prepareSkillResourceDelivery } from "../runtime/resources.js";
import { prepareSkillLibraryBundle, skillLibraryRevisionDir } from "./bundle.js";
import { uploadSkillLibrary } from "./import.js";
import {
  changeSkillLibrarySelection,
  loadSkillLibrarySelection,
  seedSkillLibrarySelection,
} from "./selection.js";
import {
  listSkillLibrary,
  mutateSkillLibrary,
  readSkillLibrary,
  saveSkillLibrary,
} from "./service.js";
import type { SkillLibraryAuthority } from "./store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const content =
  "---\nname: guide\ndescription: A reusable test procedure\n---\n# Guide\nRead references/data.bin before running scripts/task.sh.\n";
function fixture() {
  const stateDir = tempDirs.make("skill-library-");
  const options = {
    path: path.join(stateDir, "state", "openclaw.sqlite"),
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  };
  const alice = ensureProfileForEmail("alice@example.test", options);
  const actor = (profileId?: string, admin = false): SkillLibraryAuthority => ({
    profileId,
    scopes: admin ? ["operator.admin"] : ["operator.read", "operator.write"],
    getConfig: () => ({}),
    assertCurrent: () => {},
  });
  return { options, alice: actor(alice.id), admin: actor(alice.id, true), actor, stateDir };
}
const draft = (slug = "guide") => ({
  slug,
  content,
  expectedRevision: null,
  files: [
    { path: "references/data.bin", content: "AP+A", encoding: "base64" as const },
    { path: "scripts/task.sh", content: "#!/bin/sh\nprintf ready", executable: true },
  ],
});

async function beginZipUpload(
  authority: SkillLibraryAuthority,
  bytes: Buffer,
  slug: string,
  options: ReturnType<typeof fixture>["options"],
) {
  const begun = await uploadSkillLibrary(
    authority,
    {
      action: "begin",
      slug,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    options,
  );
  if (!("uploadId" in begun)) {
    throw new Error("Expected upload ID");
  }
  expect(begun.offset).toBe(0);
  return begun;
}

describe("profile-owned skill publication and selection", () => {
  it("uses the same readable identity in the prompt and picker and rejects a copied workspace command", async () => {
    const { options, alice, stateDir } = fixture();
    await saveSkillLibrary(alice, draft("long---skill---name"), options);
    const pins = seedSkillLibrarySelection(alice, options);
    const entries = loadSkillLibrarySelection(pins, options);
    const { buildSkillSnapshot } = await import("../loading/workspace-skill-prompt.js");
    const { buildWorkspaceSkillCommandSpecs } = await import("../discovery/command-specs.js");
    const snapshot = buildSkillSnapshot(stateDir, { entries });
    const commands = buildWorkspaceSkillCommandSpecs(stateDir, { entries });
    expect(pins[0]!.name).toMatch(/^s_long_skil_[a-f0-9]{20}$/);
    expect(commands[0]).toMatchObject({ name: pins[0]!.name, skillName: pins[0]!.name });
    expect(snapshot.prompt).toContain(`<name>${pins[0]!.name}</name>`);
    const copied = {
      ...entries[0]!,
      skill: { ...entries[0]!.skill, source: "openclaw-workspace" },
    };
    expect(() => buildSkillSnapshot(stateDir, { entries: [copied, ...entries] })).toThrow(
      "ambiguous",
    );
    expect(() =>
      buildWorkspaceSkillCommandSpecs(stateDir, { entries: [copied, ...entries] }),
    ).toThrow("ambiguous");
  });
  it("discovers pinned commands through the loader without leaking them into workspace state", async () => {
    const { alice, options, stateDir } = fixture();
    const saved = await saveSkillLibrary(alice, draft(), options);
    const pins = seedSkillLibrarySelection(alice, options);
    await saveSkillLibrary(
      alice,
      {
        ...draft(),
        skillId: saved.entry.skillId,
        expectedRevision: saved.entry.revision,
        content: `${content}\nUpdated`,
      },
      options,
    );
    const { listSkillCommandsForWorkspace } = await import("../discovery/chat-commands.js");
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const cfg = { agents: { defaults: { skills: [] } } };
      const discover = (
        overrides: Partial<Parameters<typeof listSkillCommandsForWorkspace>[0]> = {},
      ) =>
        listSkillCommandsForWorkspace({
          workspaceDir: stateDir,
          cfg,
          agentId: "main",
          sessionEntry: { skillLibrarySelections: pins },
          ...overrides,
        });
      const commands = discover({ skillFilter: [saved.entry.name] });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        name: saved.entry.name,
        skillFile: expect.stringContaining(saved.entry.revision),
      });
      expect(discover()).toEqual([]);
      expect(discover({ includeAllowlistHidden: true })).toContainEqual(commands[0]);
      expect(
        discover({
          includeAllowlistHidden: true,
          cfg: { ...cfg, skills: { entries: { [saved.entry.name]: { enabled: false } } } },
        }).map((entry) => entry.name),
      ).not.toContain(saved.entry.name);
      expect(discover({ sessionEntry: undefined, skillFilter: [saved.entry.name] })).toEqual([]);
    });
  });

  it("keeps solo defaults, counts aliases once, and never creates library tables on discovery", () => {
    const { options, admin, alice, actor } = fixture();
    expect(listSkillLibrary(admin, {}, options)).toMatchObject({
      defaultTarget: "workspace",
      multipleProfiles: false,
    });
    expect(listSkillLibrary(actor(undefined, true), {}, options).defaultTarget).toBe("workspace");
    expect(listSkillLibrary(alice, {}, options).defaultTarget).toBe("personal");
    expect(seedSkillLibrarySelection(alice, options)).toEqual([]);
    expect(tableExists(openOpenClawStateDatabase(options).db, "skill_library_entries")).toBe(false);
    linkEmail("alice-alias@example.test", alice.profileId!, options);
    expect(listSkillLibrary(admin, {}, options).multipleProfiles).toBe(false);
    ensureProfileForEmail("bob@example.test", options);
    expect(listSkillLibrary(admin, {}, options)).toMatchObject({
      defaultTarget: "personal",
      multipleProfiles: true,
    });
  });

  it("enforces independent read/write/transfer checks and preserves a removed session pin", async () => {
    const { options, alice, admin, actor } = fixture();
    const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
    const created = await saveSkillLibrary(alice, draft(), options);
    const { skillId, revision } = created.entry;
    const selection = seedSkillLibrarySelection(alice, options);
    const anonymousAdmin = actor(undefined, true);
    const expectAnonymousReadOnly = async () => {
      const read = await readSkillLibrary(anonymousAdmin, skillId, undefined, options);
      expect(read.content).toBe(content);
      expect(read.entry.canEdit).toBe(false);
      expect(listSkillLibrary(anonymousAdmin, {}, options)).toMatchObject({
        defaultTarget: "workspace",
        canManageWorkspace: true,
        entries: [expect.objectContaining({ skillId, canEdit: false })],
      });
      await expect(
        saveSkillLibrary(
          anonymousAdmin,
          { ...draft(), skillId, expectedRevision: revision },
          options,
        ),
      ).rejects.toMatchObject({ code: "IDENTITY_REQUIRED" });
      expect(() =>
        mutateSkillLibrary(
          anonymousAdmin,
          { skillId, expectedRevision: revision, action: "remove" },
          options,
        ),
      ).toThrow(expect.objectContaining({ code: "IDENTITY_REQUIRED" }));
    };
    await expectAnonymousReadOnly();
    await expect(readSkillLibrary(bob, skillId, undefined, options)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(saveSkillLibrary(actor(), draft(), options)).rejects.toMatchObject({
      code: "IDENTITY_REQUIRED",
    });
    mutateSkillLibrary(alice, { skillId, expectedRevision: revision, action: "share" }, options);
    expect((await readSkillLibrary(bob, skillId, undefined, options)).content).toBe(content);
    expect(() =>
      mutateSkillLibrary(bob, { skillId, expectedRevision: revision, action: "remove" }, options),
    ).toThrow("Only the skill's owner");
    expect(() =>
      mutateSkillLibrary(
        alice,
        { skillId, expectedRevision: revision, action: "transfer" },
        options,
      ),
    ).toThrow("administrator");
    const transferred = mutateSkillLibrary(
      admin,
      { skillId, expectedRevision: revision, action: "transfer" },
      options,
    );
    expect(transferred.entry).toMatchObject({
      skillId,
      revision,
      ownerProfileId: null,
      authorProfileId: alice.profileId,
    });
    await expectAnonymousReadOnly();
    expect(listSkillLibrary(actor(undefined, true), { scope: "mine" }, options).entries).toEqual(
      [],
    );
    mutateSkillLibrary(admin, { skillId, expectedRevision: revision, action: "remove" }, options);
    expect(listSkillLibrary(bob, {}, options).entries).toEqual([]);
    expect(loadSkillLibrarySelection(selection, options)[0]?.skill.filePath).toContain(revision);
    expect(() =>
      changeSkillLibrarySelection(
        bob,
        [],
        { action: "attach", sessionKey: "session", skillId },
        options,
      ),
    ).toThrow("Removed skill");
    const bytes = await fs.readFile(
      path.join(skillLibraryRevisionDir(skillId, revision, options.env), "references/data.bin"),
    );
    expect(bytes).toEqual(Buffer.from([0, 255, 128]));
  });

  it("makes identical saves a no-op, rejects racing writers, and leaves existing pins on the old bytes", async () => {
    const { options, alice } = fixture();
    const created = await saveSkillLibrary(alice, draft(), options);
    const { skillId, revision } = created.entry;
    const pins = seedSkillLibrarySelection(alice, options);
    expect(
      (await saveSkillLibrary(alice, { ...draft(), skillId, expectedRevision: revision }, options))
        .state,
    ).toBe("unchanged");
    const edits = await Promise.allSettled(
      ["first", "second"].map((body) =>
        saveSkillLibrary(
          alice,
          { ...draft(), skillId, expectedRevision: revision, content: `${content}\n${body}` },
          options,
        ),
      ),
    );
    expect(edits.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(edits.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "CONFLICT" },
    });
    expect((await readSkillLibrary(alice, skillId, pins[0]!.revision, options)).content).toBe(
      content,
    );
    const current = (await readSkillLibrary(alice, skillId, undefined, options)).entry;
    expect(current.revision).not.toBe(revision);
    const refreshed = changeSkillLibrarySelection(
      alice,
      pins,
      { action: "refresh", sessionKey: "session" },
      options,
    );
    expect(refreshed[0]?.revision).toBe(current.revision);
    mutateSkillLibrary(
      alice,
      { skillId, expectedRevision: current.revision, action: "rollback", revision },
      options,
    );
    expect((await readSkillLibrary(alice, skillId, undefined, options)).content).toBe(content);
  });

  it("rejects lost authority after asynchronous publication work without publishing a pointer", async () => {
    const { options, alice } = fixture();
    let live = true;
    const authority = {
      ...alice,
      assertCurrent: () => {
        if (!live) {
          throw new Error("retired run");
        }
      },
    };
    const saving = saveSkillLibrary(authority, draft(), options);
    live = false;
    await expect(saving).rejects.toThrow("retired run");
    expect(listSkillLibrary(alice, {}, options).entries).toEqual([]);
  });

  it("rejects same-library collisions while retaining both authors' same-name skills across profile merge", async () => {
    const { options, alice, actor } = fixture();
    const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
    const a = await saveSkillLibrary(alice, draft(), options);
    const b = await saveSkillLibrary(bob, draft(), options);
    await expect(saveSkillLibrary(alice, draft(), options)).rejects.toMatchObject({
      code: "NAME_CONFLICT",
    });
    linkEmail("bob@example.test", alice.profileId!, options);
    const entries = listSkillLibrary(alice, { scope: "mine" }, options).entries;
    expect(entries.map((entry) => entry.skillId).toSorted()).toEqual(
      [a.entry.skillId, b.entry.skillId].toSorted(),
    );
    expect(new Set(entries.map((entry) => entry.name)).size).toBe(2);
    expect(
      (await readSkillLibrary(alice, b.entry.skillId, undefined, options)).entry.ownerProfileId,
    ).toBe(alice.profileId);
  });

  it("delivers complete immutable supporting files into a worker-owned directory", async () => {
    const { options, alice, stateDir } = fixture();
    await saveSkillLibrary(alice, draft(), options);
    const selections = seedSkillLibrarySelection(alice, options);
    const skills = loadSkillLibrarySelection(selections, options).map((entry) => entry.skill);
    const snapshot = {
      prompt: "",
      skills: skills.map((skill) => ({ name: skill.name })),
      resolvedSkills: skills,
      librarySelections: selections,
      version: 1,
    };
    const delivery = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      prepareSkillResourceDelivery(snapshot, () => {}),
    );
    expect(delivery).toBeDefined();
    const materialized = await materializeSkillResources(delivery!, () => {});
    try {
      const skill = materialized.snapshot.resolvedSkills![0]!;
      expect(await fs.readFile(skill.filePath, "utf8")).toBe(content);
      expect(await fs.readFile(path.join(skill.baseDir, "references/data.bin"))).toEqual(
        Buffer.from([0, 255, 128]),
      );
      expect(materialized.snapshot.prompt).toContain(skill.filePath);
      expect(materialized.snapshot.prompt).not.toContain(
        skillLibraryRevisionDir(selections[0]!.skillId, selections[0]!.revision, options.env),
      );
    } finally {
      await materialized.cleanup();
    }
    expect(prepareSkillLibraryBundle(delivery!.skills[0]!.files).revision).toBe(
      delivery!.skills[0]!.revision,
    );
  });

  it("reads published executable metadata from the manifest and detects changed resource bytes", async () => {
    const { options, alice } = fixture();
    const saved = await saveSkillLibrary(alice, draft(), options);
    const directory = skillLibraryRevisionDir(
      saved.entry.skillId,
      saved.entry.revision,
      options.env,
    );
    const script = path.join(directory, "scripts/task.sh");
    await fs.chmod(script, 0o400);
    const read = await readSkillLibrary(alice, saved.entry.skillId, undefined, options);
    expect(read.files.find((file) => file.path === "scripts/task.sh")?.executable).toBe(true);
    expect(read.entry.revision).toBe(saved.entry.revision);
    await fs.chmod(script, 0o600);
    await fs.writeFile(script, "changed");
    await expect(readSkillLibrary(alice, saved.entry.skillId, undefined, options)).rejects.toThrow(
      "integrity verification",
    );
  });
  it("delivers the pinned hidden revision on explicit selection after the library default changes", async () => {
    const { alice, options, stateDir } = fixture();
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const hiddenContent = content.replace(
        "---\n# Guide",
        "disable-model-invocation: true\n---\n# Guide",
      );
      const saved = await saveSkillLibrary(alice, { ...draft(), content: hiddenContent }, options);
      const pins = seedSkillLibrarySelection(alice, options);
      const entries = loadSkillLibrarySelection(pins, options);
      const { buildSkillSnapshot } = await import("../loading/workspace-skill-prompt.js");
      const snapshot = { ...buildSkillSnapshot(stateDir, { entries }), librarySelections: pins };
      expect(snapshot.resolvedSkills).toEqual([]);
      await saveSkillLibrary(
        alice,
        {
          ...draft(),
          skillId: saved.entry.skillId,
          expectedRevision: saved.entry.revision,
          content: `${hiddenContent}\nChanged default`,
        },
        options,
      );
      const ordinary = await prepareSkillResourceDelivery(snapshot, () => {});
      const explicit = await prepareSkillResourceDelivery(snapshot, () => {}, [
        { name: pins[0]!.name, path: entries[0]!.skill.filePath },
      ]);
      expect(ordinary?.skills[0]).toMatchObject({
        revision: saved.entry.revision,
        modelVisible: false,
      });
      expect(explicit?.skills[0]).toMatchObject({
        name: pins[0]!.name,
        revision: saved.entry.revision,
        modelVisible: true,
      });
      expect(explicit?.skills[0]?.files).toEqual(ordinary?.skills[0]?.files);
      const markdown = explicit!.skills[0]!.files.find((file) => file.path === "SKILL.md")!;
      expect(Buffer.from(markdown.content, "base64").toString("utf8")).toBe(hiddenContent);
      expect(snapshot.librarySelections).toEqual(pins);
    });
  });
});

describe("library admission and imports", () => {
  it("checks prerequisites without borrowing another skill's config key", async () => {
    const { alice, options, stateDir } = fixture();
    const saved = await saveSkillLibrary(
      alice,
      {
        slug: "prerequisite",
        expectedRevision: null,
        content:
          '---\nname: prerequisite\ndescription: Requires explicitly configured inputs\nmetadata: {"openclaw":{"skillKey":"someone-elses-key","requires":{"env":["OPENCLAW_SKILL_LIBRARY_FIXTURE_REQUIRED"],"config":["channels.fixture.enabled"]}}}\n---\n# Prerequisite\n',
      },
      options,
    );
    const selected = loadSkillLibrarySelection(seedSkillLibrarySelection(alice, options), options);
    expect(selected[0]?.metadata?.skillKey).toBe(saved.entry.name);
    expect(selected[0]?.metadata?.requires).toMatchObject({
      env: ["OPENCLAW_SKILL_LIBRARY_FIXTURE_REQUIRED"],
      config: ["channels.fixture.enabled"],
    });
    const { buildSkillSnapshot } = await import("../loading/workspace-skill-prompt.js");
    const snapshot = buildSkillSnapshot(stateDir, {
      entries: selected,
      config: {
        skills: {
          entries: {
            "someone-elses-key": {
              env: { OPENCLAW_SKILL_LIBRARY_FIXTURE_REQUIRED: "fixture-value" },
            },
          },
        },
      },
    });
    expect(snapshot.skills).toEqual([]);
  });
  it("revalidates a new seed after a sharing change while committed pins keep working", async () => {
    const { alice, actor, options } = fixture();
    const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
    const saved = await saveSkillLibrary(alice, draft(), options);
    mutateSkillLibrary(
      alice,
      { action: "share", skillId: saved.entry.skillId, expectedRevision: saved.entry.revision },
      options,
    );
    const freshSeed = seedSkillLibrarySelection(bob, options);
    const durablePins = structuredClone(freshSeed);
    mutateSkillLibrary(
      alice,
      { action: "unshare", skillId: saved.entry.skillId, expectedRevision: saved.entry.revision },
      options,
    );
    const { assertPreparedSkillLibrarySelection } = await import("./selection.js");
    expect(() => assertPreparedSkillLibrarySelection(freshSeed)).toThrow("accessible library");
    expect(() => assertPreparedSkillLibrarySelection(durablePins)).not.toThrow();
    expect(loadSkillLibrarySelection(durablePins, options)).toHaveLength(1);
  });
  it("binds ZIP uploads to the owner and ignores archive order and timestamps for revision identity", async () => {
    const { alice, actor, options } = fixture();
    const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
    const { default: JSZip } = await import("jszip");
    const revisions: string[] = [];
    const script = "#!/bin/sh\nprintf ready";
    const resourcePath = `${"nested/".repeat(15)}data.bin`;
    for (const index of [0, 1]) {
      const zip = new JSZip();
      const files: Array<[string, string | Buffer]> = [
        ["SKILL.md", content],
        [resourcePath, Buffer.from([0, 255, 128])],
        ["scripts/task.sh", script],
      ];
      for (const [file, bytes] of index ? files.toReversed() : files) {
        zip.file(`wrapped/${file}`, bytes, {
          date: new Date(2020 + index, 0, 1),
          unixPermissions: file.endsWith(".sh") ? 0o100755 : 0o100644,
        });
      }
      const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
      const begun = await beginZipUpload(alice, bytes, `zip-${index}`, options);
      await expect(
        uploadSkillLibrary(
          bob,
          { action: "chunk", uploadId: begun.uploadId, offset: 0, data: bytes.toString("base64") },
          options,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        uploadSkillLibrary(
          alice,
          { action: "chunk", uploadId: begun.uploadId, offset: 0, data: bytes.toString("base64") },
          options,
        ),
      ).resolves.toEqual({ ...begun, offset: bytes.length });
      await expect(
        uploadSkillLibrary(bob, { action: "commit", uploadId: begun.uploadId }, options),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const saved = await uploadSkillLibrary(
        alice,
        { action: "commit", uploadId: begun.uploadId },
        options,
      );
      if (!("entry" in saved)) {
        throw new Error("Expected publication receipt");
      }
      revisions.push(saved.entry.revision);
      const read = await readSkillLibrary(alice, saved.entry.skillId, undefined, options);
      expect(read.content).toBe(content);
      expect(read.files).toEqual([
        { path: resourcePath, content: "AP+A", encoding: "base64", executable: false },
        {
          path: "scripts/task.sh",
          content: Buffer.from(script).toString("base64"),
          encoding: "base64",
          executable: true,
        },
      ]);
      expect(
        await uploadSkillLibrary(alice, { action: "commit", uploadId: begun.uploadId }, options),
      ).toMatchObject({ state: "unchanged", entry: { skillId: saved.entry.skillId } });
    }
    expect(revisions[0]).toBe(revisions[1]);
  });
  it("reserves pending import capacity for other profiles without counting completed receipts", async () => {
    const { alice, actor, options } = fixture();
    const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
    const charlie = actor(ensureProfileForEmail("charlie@example.test", options).id);
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("SKILL.md", content);
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const completed = await beginZipUpload(alice, bytes, "completed", options);
    await uploadSkillLibrary(
      alice,
      { action: "chunk", uploadId: completed.uploadId, offset: 0, data: bytes.toString("base64") },
      options,
    );
    const receipt = await uploadSkillLibrary(
      alice,
      { action: "commit", uploadId: completed.uploadId },
      options,
    );
    if (!("entry" in receipt)) {
      throw new Error("Expected completed import receipt");
    }
    for (let index = 0; index < 16; index++) {
      await beginZipUpload(alice, bytes, `alice-pending-${index}`, options);
    }
    await expect(beginZipUpload(alice, bytes, "over-profile-limit", options)).rejects.toMatchObject(
      {
        code: "LIMIT",
      },
    );
    for (let index = 0; index < 16; index++) {
      await beginZipUpload(bob, bytes, `bob-pending-${index}`, options);
    }
    await expect(
      beginZipUpload(charlie, bytes, "over-global-limit", options),
    ).rejects.toMatchObject({
      code: "LIMIT",
    });
    await expect(
      uploadSkillLibrary(alice, { action: "commit", uploadId: completed.uploadId }, options),
    ).resolves.toMatchObject({ state: "unchanged", entry: { skillId: receipt.entry.skillId } });
    expect(listSkillLibrary(alice, {}, options).entries.map((entry) => entry.skillId)).toEqual([
      receipt.entry.skillId,
    ]);
  });

  it("counts merged upload owners together while preserving completion and expiry", async () => {
    const { alice, actor, options } = fixture();
    const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
    const { default: JSZip } = await import("jszip");
    const bytes = await new JSZip().file("SKILL.md", content).generateAsync({ type: "nodebuffer" });
    const begun = await beginZipUpload(bob, bytes, "before-merge", options);
    for (let index = 0; index < 8; index++) {
      await beginZipUpload(alice, bytes, `alice-${index}`, options);
      await beginZipUpload(bob, bytes, `bob-${index}`, options);
    }
    linkEmail("bob@example.test", alice.profileId!, options);
    // Durable upload owners and retained connections may still carry Bob's pre-merge ID.
    for (const authority of [alice, bob]) {
      await expect(beginZipUpload(authority, bytes, "after-merge", options)).rejects.toMatchObject({
        code: "LIMIT",
      });
    }
    await uploadSkillLibrary(
      alice,
      { action: "chunk", uploadId: begun.uploadId, offset: 0, data: bytes.toString("base64") },
      options,
    );
    await expect(
      uploadSkillLibrary(bob, { action: "commit", uploadId: begun.uploadId }, options),
    ).resolves.toMatchObject({ state: "published", entry: { ownerProfileId: alice.profileId } });
    await expect(beginZipUpload(alice, bytes, "still-full", options)).rejects.toMatchObject({
      code: "LIMIT",
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
    try {
      await expect(beginZipUpload(bob, bytes, "after-expiry", options)).resolves.toMatchObject({
        offset: 0,
      });
      await expect(
        uploadSkillLibrary(alice, { action: "commit", uploadId: begun.uploadId }, options),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects a compressed oversized ZIP member at extraction before publishing a skill", async () => {
    const { alice, options } = fixture();
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("wrapped/SKILL.md", content);
    zip.file("wrapped/oversized.bin", Buffer.alloc(SKILL_LIBRARY_MAX_FILE_BYTES + 1, 97));
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    expect(bytes.length).toBeLessThan(4096);
    const begun = await beginZipUpload(alice, bytes, "oversized", options);
    await expect(
      uploadSkillLibrary(
        alice,
        { action: "chunk", uploadId: begun.uploadId, offset: 0, data: bytes.toString("base64") },
        options,
      ),
    ).resolves.toEqual({ ...begun, offset: bytes.length });
    await expect(
      uploadSkillLibrary(alice, { action: "commit", uploadId: begun.uploadId }, options),
    ).rejects.toMatchObject({
      code: "INVALID_BUNDLE",
      message:
        "failed to extract archive: ArchiveLimitError: archive entry extracted size exceeds limit",
    });
    expect(listSkillLibrary(alice, {}, options).entries).toEqual([]);
    expect(seedSkillLibrarySelection(alice, options)).toEqual([]);
  });
  it("bounds growing team defaults without stopping session creation", async () => {
    const { alice, actor, options } = fixture();
    const bob = actor(ensureProfileForEmail("bob@example.test", options).id);
    for (let index = 0; index < 65; index += 1) {
      const saved = await saveSkillLibrary(
        alice,
        { slug: `team-${index}`, content, expectedRevision: null },
        options,
      );
      mutateSkillLibrary(
        alice,
        { action: "share", skillId: saved.entry.skillId, expectedRevision: saved.entry.revision },
        options,
      );
    }
    const library = listSkillLibrary(bob, {}, options);
    const selected = seedSkillLibrarySelection(bob, options);
    expect(library.defaultSelectionNotice).toContain("detach");
    expect(selected).toHaveLength(64);
    const omitted = library.entries.find(
      (entry) => !selected.some((pin) => pin.skillId === entry.skillId),
    )!;
    const fewer = changeSkillLibrarySelection(
      bob,
      selected,
      { sessionKey: "test", action: "detach", skillId: selected[0]!.skillId },
      options,
    );
    expect(
      changeSkillLibrarySelection(
        bob,
        fewer,
        { sessionKey: "test", action: "attach", skillId: omitted.skillId },
        options,
      ),
    ).toHaveLength(64);
  });
});
