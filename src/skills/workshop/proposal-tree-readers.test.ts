import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { readSkillProposalDraftDirectory } from "./proposal-draft.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

const readers = [
  { name: "target", read: readSkillProposalTargetTreeSha256, marker: "SKILL.md", depth: 16 },
  {
    name: "target with root metadata",
    read: (dir: string) => readSkillProposalTargetTreeSha256(dir, { includeRootMetadata: true }),
    marker: "SKILL.md",
    depth: 16,
  },
  { name: "draft", read: readSkillProposalDraftDirectory, marker: "PROPOSAL.md", depth: 8 },
];

describe.each(readers)("Skill Workshop $name tree", ({ read, marker, depth }) => {
  it("rejects an unreadable directory instead of returning a partial tree", async () => {
    const dir = await tempDirs.make("openclaw-proposal-tree-");
    const blocked = path.join(dir, "references");
    await fs.mkdir(blocked);
    await fs.writeFile(path.join(dir, marker), "# Proposal\n");
    await fs.writeFile(path.join(blocked, "needed.md"), "Required evidence.\n");
    const denied = Object.assign(new Error(`Cannot read ${blocked}`), { code: "EACCES" });
    const readdir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation((...args) =>
      args[0] === blocked ? Promise.reject(denied) : readdir(...args),
    );

    await expect(read(dir)).rejects.toBe(denied);
  });

  it("reads the deepest allowed file and rejects content one level deeper", async () => {
    const dir = await tempDirs.make("openclaw-proposal-tree-");
    const leaf = path.join(
      dir,
      "references",
      ...Array.from({ length: depth - 2 }, (_, index) => `level-${index}`),
    );
    await fs.mkdir(leaf, { recursive: true });
    await fs.writeFile(path.join(dir, marker), "# Proposal\n");
    const boundaryFile = path.join(leaf, "boundary.md");
    await fs.writeFile(boundaryFile, "At the limit.\n");
    const before = await read(dir);
    await fs.writeFile(boundaryFile, "Changed at the limit.\n");
    expect(await read(dir)).not.toEqual(before);
    await fs.mkdir(path.join(leaf, "deeper"));
    await fs.writeFile(path.join(leaf, "deeper", "omitted.md"), "Must not disappear.\n");

    await expect(read(dir)).rejects.toThrow("exceeds traversal limits");
  });
});

describe("Skill Workshop target tree exclusions", () => {
  it("treats a missing create target as empty but propagates an unreadable root", async () => {
    const dir = await tempDirs.make("openclaw-proposal-tree-");
    const emptyHash = await readSkillProposalTargetTreeSha256(dir);
    await expect(readSkillProposalTargetTreeSha256(path.join(dir, "missing"))).resolves.toBe(
      emptyHash,
    );
    const denied = Object.assign(new Error(`Cannot read ${dir}`), { code: "EACCES" });
    const readdir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation((...args) =>
      args[0] === dir ? Promise.reject(denied) : readdir(...args),
    );
    await expect(readSkillProposalTargetTreeSha256(dir)).rejects.toBe(denied);
  });

  it("excludes root metadata from traversal limits without excluding nested skill content", async () => {
    const dir = await tempDirs.make("openclaw-proposal-tree-");
    await fs.writeFile(path.join(dir, "SKILL.md"), "# Proposal\n");
    const initialHash = await readSkillProposalTargetTreeSha256(dir);
    const metadata = path.join(dir, ".openclaw");
    await fs.mkdir(metadata);
    await Promise.all(
      Array.from({ length: 513 }, (_, index) => fs.mkdir(path.join(metadata, `entry-${index}`))),
    );
    await expect(readSkillProposalTargetTreeSha256(dir)).resolves.toBe(initialHash);
    await expect(
      readSkillProposalTargetTreeSha256(dir, { includeRootMetadata: true }),
    ).rejects.toThrow("exceeds traversal limits");
    const nested = path.join(dir, "references", ".openclaw");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "content.md"), "Ordinary nested skill content.\n");
    await expect(readSkillProposalTargetTreeSha256(dir)).resolves.not.toBe(initialHash);
  });
});
