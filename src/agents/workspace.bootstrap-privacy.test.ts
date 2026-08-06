/** Tests workspace bootstrap privacy policy and loader source provenance. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  DEFAULT_MEMORY_FILENAME,
  filterBootstrapFilesForSession,
  loadExtraBootstrapFilesWithDiagnostics,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
  workspaceFilesShareSourceIdentity,
} from "./workspace.js";

const mockFiles: WorkspaceBootstrapFile[] = [
  { name: "AGENTS.md", path: "/w/AGENTS.md", content: "", missing: false },
  { name: "SOUL.md", path: "/w/SOUL.md", content: "", missing: false },
  { name: "IDENTITY.md", path: "/w/IDENTITY.md", content: "", missing: false },
  { name: "USER.md", path: "/w/USER.md", content: "", missing: false },
  { name: "BOOTSTRAP.md", path: "/w/BOOTSTRAP.md", content: "", missing: false },
  { name: "MEMORY.md", path: "/w/MEMORY.md", content: "", missing: false },
];

describe("workspace bootstrap source identity", () => {
  it("carries canonical source identity through extra-file conversion", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-source-identity-");
    const nestedDir = path.join(tempDir, "packages", "core");
    const rootAliasDir = path.join(tempDir, "root-memory-alias");
    const nestedAliasDir = path.join(tempDir, "nested-memory-alias");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, DEFAULT_MEMORY_FILENAME), "root memory", "utf8");
    await fs.writeFile(path.join(nestedDir, DEFAULT_MEMORY_FILENAME), "nested memory", "utf8");
    await fs.symlink(tempDir, rootAliasDir, process.platform === "win32" ? "junction" : "dir");
    await fs.symlink(nestedDir, nestedAliasDir, process.platform === "win32" ? "junction" : "dir");

    const rootMemory = (await loadWorkspaceBootstrapFiles(tempDir)).find(
      (file) => file.name === DEFAULT_MEMORY_FILENAME,
    );
    const { files: aliases } = await loadExtraBootstrapFilesWithDiagnostics(tempDir, [
      path.relative(tempDir, path.join(rootAliasDir, DEFAULT_MEMORY_FILENAME)),
      path.relative(tempDir, path.join(nestedAliasDir, DEFAULT_MEMORY_FILENAME)),
    ]);
    const rootAlias = aliases.find((file) => file.path.startsWith(rootAliasDir));
    const nestedAlias = aliases.find((file) => file.path.startsWith(nestedAliasDir));

    expect(rootMemory).toBeDefined();
    expect(rootAlias).toBeDefined();
    expect(nestedAlias).toBeDefined();
    expect(workspaceFilesShareSourceIdentity(rootMemory!, rootAlias!)).toBe(true);
    expect(workspaceFilesShareSourceIdentity(rootMemory!, nestedAlias!)).toBe(false);
  });
});

describe("filterBootstrapFilesForSession privacy", () => {
  it.each(["agent:default:discord:direct:user-1", "agent:default:telegram:dm:123456"])(
    "keeps MEMORY.md for direct sessions (%s)",
    (sessionKey) => {
      expect(filterBootstrapFilesForSession(mockFiles, sessionKey)).toStrictEqual(mockFiles);
    },
  );

  it.each([
    "agent:default:discord:channel:c1",
    "agent:default:telegram:group:-1001234567890:topic:99",
  ])("drops only MEMORY.md for shared sessions (%s)", (sessionKey) => {
    const result = filterBootstrapFilesForSession(mockFiles, sessionKey);
    expect(result).toStrictEqual(mockFiles.filter((file) => file.name !== "MEMORY.md"));
  });

  it("prefers authoritative chat type over the session-key fallback", () => {
    const shared = filterBootstrapFilesForSession(mockFiles, {
      sessionKey: "agent:default:opaque:binding",
      chatType: "group",
    });
    const direct = filterBootstrapFilesForSession(mockFiles, {
      sessionKey: "agent:default:discord:channel:c1",
      chatType: "direct",
    });

    expect(shared).toStrictEqual(mockFiles.filter((file) => file.name !== "MEMORY.md"));
    expect(direct).toStrictEqual(mockFiles);
  });

  it("drops root memory path aliases while preserving nested memory in shared sessions", () => {
    const rootMemoryAlias: WorkspaceBootstrapFile = {
      name: "SOUL.md",
      path: "/w/private/../MEMORY.md",
      content: "",
      missing: false,
    };
    const nestedMemory: WorkspaceBootstrapFile = {
      name: "MEMORY.md",
      path: "/w/packages/core/MEMORY.md",
      content: "",
      missing: false,
    };

    const result = filterBootstrapFilesForSession([rootMemoryAlias, nestedMemory], {
      sessionKey: "agent:default:opaque:binding",
      chatType: "channel",
      workspaceDir: "/w",
    });

    expect(result).toStrictEqual([nestedMemory]);
  });

  it.each([
    ["subagent", "agent:default:subagent:task-1", "AGENTS.md"],
    ["cron", "agent:default:cron:daily-check", "SOUL.md"],
  ] as const)(
    "drops root memory path aliases before the %s allowlist",
    (_mode, sessionKey, name) => {
      const allowedFile = mockFiles.find((file) => file.name === name)!;
      const rootMemoryAlias: WorkspaceBootstrapFile = {
        name,
        path: "/w/MEMORY.md",
        content: "",
        missing: false,
      };

      const result = filterBootstrapFilesForSession([allowedFile, rootMemoryAlias], {
        sessionKey,
        workspaceDir: "/w",
      });

      expect(result).toStrictEqual([allowedFile]);
    },
  );
});
