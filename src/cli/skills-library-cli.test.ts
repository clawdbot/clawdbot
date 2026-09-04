import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillsLibraryReadResult } from "../../packages/gateway-protocol/src/index.js";
import { registerSkillsLibraryCli } from "./skills-library-cli.js";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
}));
vi.mock("./gateway-rpc.runtime.js", () => ({ callGatewayFromCliRuntime: mocks.call }));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: {
    log: vi.fn(),
    error: mocks.error,
    writeJson: mocks.writeJson,
    writeStdout: mocks.writeStdout,
    exit: mocks.exit,
  },
}));
const skillId = "11111111-1111-4111-8111-111111111111";
const revision = "a".repeat(64);
const read: SkillsLibraryReadResult = {
  entry: {
    skillId,
    slug: "checklist",
    name: "s_checklist_11111111111141118111",
    description: "A checklist",
    ownerProfileId: "profile-alice",
    ownerLabel: "Alice",
    authorProfileId: "profile-alice",
    shared: false,
    enabled: true,
    removed: false,
    revision,
    createdAt: 1,
    updatedAt: 1,
    canEdit: true,
  },
  content: "---\nname: checklist\ndescription: A checklist\n---\nOriginal content\n",
  files: [
    { path: "assets/raw.bin", content: "AAH+/w==", encoding: "base64", executable: true },
    { path: "notes.txt", content: "keep\r\n", encoding: "utf8" },
  ],
  revisions: [{ revision, createdAt: 1 }],
};
const receipt = {
  state: "published",
  target: "personal",
  entry: read.entry,
  sessionActivation: "new-sessions",
  nextAction: "Start a new session.",
};
let directory: string;
function cli() {
  const program = new Command().exitOverride();
  registerSkillsLibraryCli(program.command("skills").option("--json", "JSON", false));
  return program;
}
async function parse(args: string[]) {
  await cli().parseAsync(["skills", "library", ...args], { from: "user" });
}

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-library-cli-"));
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    "---\nname: checklist\ndescription: Updated checklist\n---\nUpdated\n",
  );
  mocks.call.mockImplementation(async (method: string) => {
    if (method === "skills.library.read") {
      return read;
    }
    if (method === "skills.library.list") {
      return {
        entries: [read.entry],
        profileId: "profile-alice",
        multipleProfiles: true,
        defaultTarget: "personal",
        canManageWorkspace: false,
        defaultSelectionLimit: 64,
      };
    }
    if (method === "skills.library.activate") {
      return { sessionKey: "agent:main:shared", selections: [], sessionActivation: "next-turn" };
    }
    return receipt;
  });
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("skills library CLI", () => {
  const leaves = [
    "list",
    "read",
    "create",
    "update",
    "import",
    "remove",
    "share",
    "unshare",
    "transfer",
    "enable",
    "disable",
    "rollback",
    "attach",
    "detach",
    "refresh",
  ];
  it.each(leaves)("inherits connection and JSON options before or after %s", async (name) => {
    const args =
      name === "list"
        ? []
        : name === "read"
          ? [skillId]
          : name === "create" || name === "import"
            ? [directory, "--slug", "checklist"]
            : name === "update"
              ? [skillId, directory, "--expected-revision", revision]
              : ["attach", "detach", "refresh"].includes(name)
                ? [
                    "--session",
                    "agent:main:shared",
                    ...(name === "refresh" ? [] : ["--skill-id", skillId]),
                  ]
                : [
                    skillId,
                    "--expected-revision",
                    revision,
                    ...(name === "rollback" ? ["--revision", "b".repeat(64)] : []),
                  ];
    const flags = [
      "--url",
      "ws://127.0.0.1:12345",
      "--port",
      "12345",
      "--timeout",
      "14000",
      "--json",
    ];
    for (const command of [
      [...flags, name, ...args],
      [name, ...args, ...flags],
    ]) {
      mocks.call.mockClear();
      await parse(command);
      expect(mocks.call).toHaveBeenCalled();
      for (const call of mocks.call.mock.calls) {
        expect(call[1]).toMatchObject({
          url: "ws://127.0.0.1:12345",
          port: "12345",
          timeout: "14000",
          json: true,
        });
      }
      expect(mocks.writeJson).toHaveBeenCalled();
    }
  });

  it("uses explicit leaf options ahead of parent options", async () => {
    await parse([
      "--url",
      "ws://parent.invalid",
      "--timeout",
      "1000",
      "list",
      "--url",
      "ws://leaf.invalid",
      "--timeout",
      "2000",
      "--json",
    ]);
    expect(mocks.call).toHaveBeenCalledWith(
      "skills.library.list",
      expect.objectContaining({ url: "ws://leaf.invalid", timeout: "2000" }),
      { scope: "all" },
      undefined,
    );
  });

  it("preserves binary bytes, executable metadata, and CRLF support when updating SKILL.md", async () => {
    await parse([
      "update",
      skillId,
      path.join(directory, "SKILL.md"),
      "--expected-revision",
      revision,
      "--json",
    ]);
    expect(mocks.call).toHaveBeenLastCalledWith(
      "skills.library.save",
      expect.anything(),
      {
        skillId,
        expectedRevision: revision,
        slug: "checklist",
        content: await fs.readFile(path.join(directory, "SKILL.md"), "utf8"),
        files: read.files,
      },
      undefined,
    );
    expect(mocks.writeJson).toHaveBeenCalledWith(receipt);
  });

  it("replaces complete directory bundles and explicitly deletes requested support files", async () => {
    await fs.mkdir(path.join(directory, "assets"));
    await fs.writeFile(path.join(directory, "assets", "new.bin"), Buffer.from([0, 255, 13, 10]));
    await parse(["update", skillId, directory, "--expected-revision", revision, "--json"]);
    expect(mocks.call.mock.calls.at(-1)?.[2]).toMatchObject({
      files: [{ path: "assets/new.bin", content: "AP8NCg==", encoding: "base64" }],
    });
    await parse([
      "update",
      skillId,
      path.join(directory, "SKILL.md"),
      "--expected-revision",
      revision,
      "--delete-file",
      "notes.txt",
      "--json",
    ]);
    expect(mocks.call.mock.calls.at(-1)?.[2]).toMatchObject({ files: [read.files[0]] });
  });

  it("prints complete supporting files and retained revisions in human read output", async () => {
    await parse(["read", skillId]);
    const output = mocks.writeStdout.mock.calls[0]?.[0];
    expect(output).toContain(read.content);
    expect(output).toContain("AAH+/w==");
    expect(output).toContain("base64, executable");
    expect(output).toContain(revision);
  });

  it("keeps the caller's expected revision when a newer revision is read for support files", async () => {
    mocks.call.mockImplementation(async (method: string) =>
      method === "skills.library.read"
        ? { ...read, entry: { ...read.entry, revision: "b".repeat(64) } }
        : receipt,
    );
    await parse([
      "update",
      skillId,
      path.join(directory, "SKILL.md"),
      "--expected-revision",
      revision,
      "--json",
    ]);
    expect(mocks.call.mock.calls.at(-1)?.[2]).toMatchObject({
      expectedRevision: revision,
      files: read.files,
    });
  });

  it.each([
    [
      "remove",
      "removed",
      "Existing sessions retain their pinned revision. Create a new skill to add it to future sessions.",
    ],
    [
      "disable",
      "published",
      "Disabled for new-session defaults. Existing sessions retain their selected revision; explicit attachment remains available.",
    ],
    [
      "unshare",
      "published",
      "Enabled for your new sessions, subject to agent policy and prerequisites. Existing session pins remain. Use skills.library.activate to attach or refresh it.",
    ],
  ])(
    "prints the canonical %s receipt without inferring readiness",
    async (action, state, nextAction) => {
      mocks.call.mockResolvedValue({ ...receipt, state, nextAction });
      await parse([action, skillId, "--expected-revision", revision]);
      const output = mocks.writeStdout.mock.calls[0]?.[0];
      expect(output).toContain(`${state}: checklist (personal, owner Alice)`);
      expect(output).toContain(nextAction);
      expect(output).not.toContain("Available in new sessions");
      expect(output).not.toContain("ready");
    },
  );

  it("lists a session projection and reads only its exact pin", async () => {
    const sessionKey = "agent:main:alice-session";
    await parse(["list", "--session", sessionKey, "--json"]);
    expect(mocks.call).toHaveBeenLastCalledWith(
      "skills.library.list",
      expect.anything(),
      { scope: "all", sessionKey },
      undefined,
    );
    await parse(["read", skillId, "--session", sessionKey, "--revision", revision, "--json"]);
    expect(mocks.call).toHaveBeenLastCalledWith(
      "skills.library.read",
      expect.anything(),
      { skillId, sessionKey, revision },
      undefined,
    );
    expect(mocks.writeJson).toHaveBeenLastCalledWith(read);
    mocks.call.mockClear();
    await parse(["read", skillId, "--session", sessionKey]);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("--session requires --revision"),
    );
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("uses private upload begin/chunk/commit for ZIP imports", async () => {
    const zip = path.join(directory, "bundle.zip");
    const bytes = Buffer.from([80, 75, 3, 4, 1]);
    await fs.writeFile(zip, bytes);
    mocks.call.mockImplementation(async (_method, _opts, params) =>
      params.action === "begin"
        ? { uploadId: skillId, offset: 0, maxChunkBytes: 3 }
        : params.action === "chunk"
          ? {
              uploadId: skillId,
              offset: params.offset + Buffer.from(params.data, "base64").length,
              maxChunkBytes: 3,
            }
          : receipt,
    );
    await parse(["import", zip, "--slug", "checklist", "--json"]);
    expect(mocks.call.mock.calls.map((call) => call[0])).toEqual(
      Array(4).fill("skills.library.upload"),
    );
    expect(mocks.call.mock.calls.map((call) => call[2].action)).toEqual([
      "begin",
      "chunk",
      "chunk",
      "commit",
    ]);
    expect(
      Buffer.concat(
        mocks.call.mock.calls
          .filter((call) => call[2].action === "chunk")
          .map((call) => Buffer.from(call[2].data, "base64")),
      ),
    ).toEqual(bytes);
  });

  it("targets an exact session and skill without workspace overrides", async () => {
    await parse([
      "attach",
      "--session",
      "agent:main:shared",
      "--skill-id",
      skillId,
      "--revision",
      revision,
      "--json",
    ]);
    expect(mocks.call).toHaveBeenCalledWith(
      "skills.library.activate",
      expect.anything(),
      { action: "attach", sessionKey: "agent:main:shared", skillId, revision },
      undefined,
    );
  });
});
