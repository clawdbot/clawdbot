import { afterEach, describe, expect, it, vi } from "vitest";
import { validateWorkerSkillWorkshopParams } from "../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSystemAgentRunAdmission } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createLibrarySkillWorkshopTool } from "../agents/tools/skill-workshop-tool-library.js";
import { listSkillLibrary, readSkillLibrary, saveSkillLibrary } from "../skills/library/service.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import {
  libraryAuthority,
  type SkillLibraryRequestOwner,
} from "./server-methods/skills-library.js";
import {
  invalidateSkillAuthoringForOtherRequester,
  prepareGatewaySkillAuthoring,
} from "./skill-library-authoring.js";

const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
const content =
  "---\nname: ordinary\ndescription: An ordinary personal procedure\n---\n# Ordinary\nUse this procedure when asked.\n";
function setup() {
  vi.stubEnv("OPENCLAW_STATE_DIR", temps.make("personal-authoring-"));
  const alice = ensureProfileForEmail("alice@example.test");
  const bob = ensureProfileForEmail("bob@example.test");
  const request = (profileId: string): SkillLibraryRequestOwner => ({
    client: {
      authenticatedUserProfile: { profileId },
      connect: { scopes: ["operator.read", "operator.write"] },
    } as SkillLibraryRequestOwner["client"],
    context: { getRuntimeConfig: () => ({}) } as SkillLibraryRequestOwner["context"],
  });
  return { alice, bob, request };
}
async function admitted(
  capability: NonNullable<ReturnType<typeof prepareGatewaySkillAuthoring>>,
  runId = "ordinary-turn",
) {
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "test");
  const context = await admission.admit("embedded");
  capability.bind(context);
  const withCaller = <T>(call: () => T) =>
    withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:shared",
        operationalRunInstance: context.operationalRunInstance,
        receiptAuthority: () => true,
      },
      call,
    );
  return {
    close: admission.close,
    invoke: (input: Parameters<typeof capability.invoke>[0]) =>
      withCaller(() => capability.invoke(input)),
    execute: (tool: ReturnType<typeof createLibrarySkillWorkshopTool>, input: unknown) =>
      withCaller(() => tool.execute("test", input)),
    context,
  };
}

describe("human personal namespace authority", () => {
  it("returns the actual slug and personal namespace edit permissions while retaining operator administration", async () => {
    const { alice, bob, request } = setup();
    const owner = request(alice.id);
    owner.client!.connect.scopes = ["operator.admin"];
    const other = await saveSkillLibrary(libraryAuthority(request(bob.id)), {
      slug: "bobs-slug",
      content,
      expectedRevision: null,
    });
    const capability = prepareGatewaySkillAuthoring(owner, "agent:main:shared", true)!;
    const run = await admitted(capability);
    const tool = createLibrarySkillWorkshopTool(capability);
    try {
      const read = JSON.parse(
        (await run.execute(tool, { action: "read", skill_id: other.entry.skillId })).content.find(
          (block) => block.type === "text",
        )!.text!,
      );
      expect(read).toMatchObject({ slug: "bobs-slug", name: other.entry.name, canEdit: false });
      await expect(
        run.invoke({
          action: "update",
          skillId: other.entry.skillId,
          expectedRevision: other.entry.revision,
          content: content + "Unauthorized edit.\n",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(listSkillLibrary(libraryAuthority(owner)).entries[0]?.canEdit).toBe(true);
      expect(await run.invoke({ action: "list" })).toMatchObject({
        entries: [expect.objectContaining({ skillId: other.entry.skillId, canEdit: false })],
      });
      const created = await run.invoke({ action: "create", slug: "my-slug", content });
      if (!("entry" in created)) {
        throw new Error("Expected receipt");
      }
      expect(await run.invoke({ action: "read", skillId: created.entry.skillId })).toMatchObject({
        entry: { slug: "my-slug", canEdit: true },
      });
      await run.invoke({
        action: "transfer",
        skillId: created.entry.skillId,
        expectedRevision: created.entry.revision,
      });
      expect(await run.invoke({ action: "read", skillId: created.entry.skillId })).toMatchObject({
        entry: { ownerProfileId: null, canEdit: false },
      });
      await expect(
        run.invoke({
          action: "update",
          skillId: created.entry.skillId,
          expectedRevision: created.entry.revision,
          content: content + "Team edit.\n",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      run.close();
    }
  });
  it("authors for the real requester inside another person's session and rejects a retained tool after close", async () => {
    const { bob, request } = setup();
    const owner = request(bob.id);
    const capability = prepareGatewaySkillAuthoring(owner, "agent:main:shared", true)!;
    const run = await admitted(capability);
    try {
      const created = await run.invoke({ action: "create", slug: "ordinary", content });
      expect(created).toMatchObject({
        state: "published",
        target: "personal",
        entry: { ownerProfileId: bob.id },
        sessionActivation: "new-sessions",
      });
      expect(listSkillLibrary(libraryAuthority(owner)).entries).toHaveLength(1);
      run.close();
      await expect(
        run.invoke({ action: "create", slug: "after-close", content }),
      ).rejects.toMatchObject({ code: "AUTHORITY_EXPIRED" });
    } finally {
      run.close();
    }
  });
  it("preserves supporting bytes on ordinary updates and permits an explicit authorized transfer", async () => {
    const { alice, request } = setup();
    const owner = request(alice.id);
    owner.client!.connect.scopes = ["operator.admin"];
    const run = await admitted(prepareGatewaySkillAuthoring(owner, "agent:main:shared", true)!);
    try {
      const created = await run.invoke({
        action: "create",
        slug: "resources",
        content,
        files: [{ path: "script.sh", content: "#!/bin/sh\nprintf ready\n", executable: true }],
      });
      if (!("entry" in created)) {
        throw new Error("Expected receipt");
      }
      const updated = await run.invoke({
        action: "update",
        skillId: created.entry.skillId,
        expectedRevision: created.entry.revision,
        slug: "resources",
        content: content + "Extra instruction.\n",
      });
      if (!("entry" in updated)) {
        throw new Error("Expected receipt");
      }
      const read = await readSkillLibrary(libraryAuthority(owner), created.entry.skillId);
      expect(Buffer.from(read.files[0]!.content, "base64").toString()).toBe(
        "#!/bin/sh\nprintf ready\n",
      );
      expect(read.files[0]?.executable).toBe(true);
      expect(
        await run.invoke({
          action: "transfer",
          skillId: updated.entry.skillId,
          expectedRevision: updated.entry.revision,
        }),
      ).toMatchObject({
        state: "published",
        target: "team",
        entry: { ownerProfileId: null, authorProfileId: alice.id },
      });
    } finally {
      run.close();
    }
  });
  it("requires admission, refuses synthetic authority, and invalidates a mixed-person steer", async () => {
    const { alice, bob, request } = setup();
    const owner = request(alice.id);
    expect(prepareGatewaySkillAuthoring(owner, "agent:main:shared", false)).toBeUndefined();
    expect(
      prepareGatewaySkillAuthoring(
        { ...owner, client: { ...owner.client!, internal: { syntheticClient: true } } },
        "agent:main:shared",
        true,
      ),
    ).toBeUndefined();
    const capability = prepareGatewaySkillAuthoring(owner, "agent:main:shared", true)!;
    await expect(capability.invoke({ action: "list" })).rejects.toMatchObject({
      code: "AUTHORITY_EXPIRED",
    });
    const run = await admitted(capability);
    try {
      invalidateSkillAuthoringForOtherRequester("agent:main:shared", bob.id);
      await expect(run.invoke({ action: "create", slug: "ambiguous", content })).rejects.toThrow(
        "fresh attributed",
      );
      expect(listSkillLibrary(libraryAuthority(owner)).entries).toHaveLength(0);
    } finally {
      run.close();
    }
  });
  it("enforces current roles at publication after asynchronous staging", async () => {
    const { alice, request } = setup();
    const owner = request(alice.id);
    owner.context.getRuntimeConfig = () => ({
      gateway: {
        roles: {
          default: "writer",
          definitions: {
            writer: { scopes: ["operator.write"], agents: "*", sessions: { others: "view" } },
            reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
          },
        },
      },
    });
    const run = await admitted(prepareGatewaySkillAuthoring(owner, "agent:main:shared", true)!);
    try {
      const saving = run.invoke({ action: "create", slug: "revoked", content });
      setUserProfileRole(alice.id, "reader");
      await expect(saving).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(listSkillLibrary(libraryAuthority(owner)).entries).toHaveLength(0);
    } finally {
      run.close();
    }
  });
  it("returns a whole bounded instruction or visible omission without embedding binary bundle data", async () => {
    const { alice, request } = setup();
    const owner = request(alice.id);
    const capability = prepareGatewaySkillAuthoring(owner, "agent:main:shared", true)!;
    const run = await admitted(capability);
    try {
      const created = await run.invoke({
        action: "create",
        slug: "large",
        content: content + "Plain guidance.\n".repeat(1300),
        files: [
          {
            path: "data.bin",
            content: Buffer.alloc(500000, 128).toString("base64"),
            encoding: "base64",
          },
        ],
      });
      if (!("entry" in created)) {
        throw new Error("Expected publication receipt");
      }
      const tool = createLibrarySkillWorkshopTool(capability);
      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:shared",
          operationalRunInstance: run.context.operationalRunInstance,
          receiptAuthority: () => true,
        },
        () => tool.execute("read", { action: "read", skill_id: created.entry.skillId }),
      );
      expect(JSON.stringify(result).length).toBeLessThan(2000);
      expect(JSON.stringify(result)).toContain('contentIncluded\\":false');
      expect(JSON.stringify(result)).toContain("Open My skills");
      expect(
        (await readSkillLibrary(libraryAuthority(owner), created.entry.skillId)).files[0]?.content
          .length,
      ).toBeGreaterThan(500000);
    } finally {
      run.close();
    }
  });
});

it("serves worker Workshop through the same Gateway capability and rejects a lost turn claim", async () => {
  const { alice, request } = setup();
  const capability = prepareGatewaySkillAuthoring(request(alice.id), "agent:main:shared", true)!;
  const run = await admitted(capability, "worker-personal-turn");
  const { registerWorkerSkillAuthoring, invokeWorkerSkillAuthoring } =
    await import("./worker-environments/worker-skill-authoring.js");
  const { createWorkerSessionTools } = await import("../worker/worker-session-tools.js");
  const claim = {
    sessionId: "shared",
    runId: "worker-personal-turn",
    claimId: "claim",
    placementGeneration: 1,
    owner: { kind: "worker" as const, environmentId: "environment", ownerEpoch: 1 },
  };
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("claim lost");
    }
  };
  const hostTool = createLibrarySkillWorkshopTool({
    ...capability,
    invoke: (input) =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:shared",
          operationalRunInstance: run.context.operationalRunInstance,
          receiptAuthority: () => {
            assertCurrent();
            return true;
          },
          workerTurnClaim: claim,
        },
        () => capability.invoke(input),
      ),
  });
  const revoke = registerWorkerSkillAuthoring(claim, hostTool, assertCurrent);
  const unused = async () => {
    throw new Error("Unexpected unrelated RPC");
  };
  const proxy = createWorkerSessionTools(
    {
      requestSessionsSend: unused,
      requestSessionsSpawn: unused,
      requestGitHubPublish: unused,
      requestPortal: unused,
      requestSkillWorkshop: async (input) => {
        expect(validateWorkerSkillWorkshopParams(input)).toBe(true);
        return {
          type: "res",
          id: "test",
          ok: true,
          payload: { resultJson: JSON.stringify(await invokeWorkerSkillAuthoring(claim, input)) },
        };
      },
    },
    { multipleProfiles: true },
  ).find((tool) => tool.name === "skill_workshop")!;
  try {
    const result = await proxy.execute("create-1", {
      action: "create",
      name: "worker-created",
      proposal_content: content,
      files: [
        { path: "scripts/edit.sh", content: "#!/bin/sh\nprintf original", executable: true },
        { path: "scripts/keep.sh", content: "#!/bin/sh\nprintf preserved", executable: true },
        { path: "data.bin", content: "AP+A", encoding: "base64" },
      ],
    });
    expect(JSON.stringify(result)).toContain(alice.id);
    expect(listSkillLibrary(libraryAuthority(request(alice.id))).entries).toHaveLength(1);
    expect(
      await proxy.execute("create-1", {
        action: "create",
        name: "worker-created",
        proposal_content: content,
        files: [
          { path: "scripts/edit.sh", content: "#!/bin/sh\nprintf original", executable: true },
          { path: "scripts/keep.sh", content: "#!/bin/sh\nprintf preserved", executable: true },
          { path: "data.bin", content: "AP+A", encoding: "base64" },
        ],
      }),
    ).toEqual(result);
    const entry = listSkillLibrary(libraryAuthority(request(alice.id))).entries[0]!;
    const readArtifact = await proxy.execute("read-helper", {
      action: "read",
      skill_id: entry.skillId,
      artifact_path: "scripts/edit.sh",
    });
    expect(
      JSON.parse(readArtifact.content.find((block) => block.type === "text")!.text!),
    ).toMatchObject({
      slug: "worker-created",
      artifactPath: "scripts/edit.sh",
      content: "#!/bin/sh\nprintf original",
      contentIncluded: true,
    });
    const binary = await proxy.execute("read-binary", {
      action: "read",
      skill_id: entry.skillId,
      artifact_path: "data.bin",
    });
    expect(JSON.parse(binary.content.find((block) => block.type === "text")!.text!)).toMatchObject({
      contentIncluded: false,
      omissionReason: "binary",
    });
    await proxy.execute("edit-helper", {
      action: "update",
      skill_id: entry.skillId,
      expected_revision: entry.revision,
      files: [{ path: "scripts/edit.sh", content: "#!/bin/sh\nprintf changed" }],
    });
    const edited = await readSkillLibrary(libraryAuthority(request(alice.id)), entry.skillId);
    expect(edited.content).toBe(content);
    expect(edited.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "data.bin", content: "AP+A", encoding: "base64" }),
        expect.objectContaining({
          path: "scripts/keep.sh",
          content: Buffer.from("#!/bin/sh\nprintf preserved").toString("base64"),
          executable: true,
        }),
        expect.objectContaining({
          path: "scripts/edit.sh",
          content: Buffer.from("#!/bin/sh\nprintf changed").toString("base64"),
          executable: true,
        }),
      ]),
    );
    await expect(
      proxy.execute("stale-edit", {
        action: "update",
        skill_id: entry.skillId,
        expected_revision: entry.revision,
        files: [{ path: "scripts/edit.sh", content: "stale" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    for (const [index, patch] of [
      { files: [{ path: "SKILL.md", content: "wrong channel" }] },
      {
        files: [
          { path: "a", content: "one" },
          { path: "A", content: "two" },
        ],
      },
      {
        files: [{ path: "scripts/edit.sh", content: "conflict" }],
        delete_files: ["scripts/edit.sh"],
      },
      { delete_files: ["SKILL.md"] },
      { delete_files: ["../escape"] },
      { delete_files: ["data.bin", "data.bin"] },
    ].entries()) {
      await expect(
        proxy.execute(`invalid-${index}`, {
          action: "update",
          skill_id: entry.skillId,
          expected_revision: edited.entry.revision,
          ...patch,
        }),
      ).rejects.toThrow();
    }
    await proxy.execute("delete-helper", {
      action: "update",
      skill_id: entry.skillId,
      expected_revision: edited.entry.revision,
      delete_files: ["scripts/keep.sh"],
    });
    const removed = await readSkillLibrary(libraryAuthority(request(alice.id)), entry.skillId);
    expect(removed.files.map((file) => file.path)).toEqual(["data.bin", "scripts/edit.sh"]);
    const unchanged = await proxy.execute("empty-upserts", {
      action: "update",
      skill_id: entry.skillId,
      expected_revision: removed.entry.revision,
      files: [],
    });
    expect(
      JSON.parse(unchanged.content.find((block) => block.type === "text")!.text!),
    ).toMatchObject({ state: "unchanged" });
    current = false;
    await expect(
      proxy.execute("create-2", {
        action: "create",
        name: "lost-claim",
        proposal_content: content,
      }),
    ).rejects.toThrow("claim lost");
  } finally {
    revoke();
    run.close();
  }
});
