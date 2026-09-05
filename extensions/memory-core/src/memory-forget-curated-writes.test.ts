import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listSessionTranscriptCorpusEntriesForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  configureMemoryCoreDreamingStateForTests,
  createMemoryCoreTestHarness,
} from "./test-helpers.js";

describe("memory forget curated writes", () => {
  const { createTempWorkspace } = createMemoryCoreTestHarness();
  let stateDir: string;
  let workspaceDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    stateDir = await fs.realpath(await createTempWorkspace("memory-forget-curated-writes-"));
    workspaceDir = path.join(stateDir, "workspace");
    await fs.mkdir(workspaceDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await configureMemoryCoreDreamingStateForTests();
    cfg = {
      agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
  });

  async function seedSession(sessionId: string): Promise<void> {
    await upsertSessionEntry({
      agentId: "main",
      sessionKey: `agent:main:${sessionId}`,
      entry: { sessionId, updatedAt: 1_000 },
    });
  }

  it("reports session-authored curated memory without deleting unattributable file content", async () => {
    await seedSession("target");
    const curatedContent = "# Long-Term Memory\nThe launch code is violet.\n";
    const writeTool = createOpenClawCodingTools({
      workspaceDir,
      config: cfg,
      sessionId: "target",
      sessionKey: "agent:main:target",
      senderIsOwner: true,
    }).find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();
    await writeTool!.execute("write-curated-memory", {
      path: "MEMORY.md",
      content: curatedContent,
    });
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "target",
      sessionKey: "agent:main:target",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "observed-write",
            name: "write",
            arguments: { path: "MEMORY.md" },
          },
        ],
      },
    });

    const preview = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["target"],
      dryRun: true,
    });
    expect(preview.curatedWrites).toEqual([
      { relativePath: "MEMORY.md", observedAt: expect.any(Number) },
    ]);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(curatedContent);

    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["target"],
    });
    expect(report).toEqual({ ...preview, dryRun: false });
    expect(report.artifacts.memoryFiles).toBe(0);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(curatedContent);
  });

  it("reports harness memory writes from selected live and archived transcripts without observer state", async () => {
    await seedSession("survivor");
    await seedSession("target");
    const observedAt = Date.parse("2026-08-26T12:34:56.000Z");
    const memoryContent = "# Long-Term Memory\nA harness-authored private fact.\n";
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memoryContent);
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "# User\n");
    await fs.writeFile(path.join(workspaceDir, "memory", "profile.md"), "# Profile\n");
    const patchInput = [
      "*** Begin Patch",
      "*** Update File: MEMORY.md",
      "@@",
      "+A harness-authored private fact.",
      "*** Update File: README.md",
      "@@",
      "+Not a memory file.",
      "*** End Patch",
    ].join("\n");
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "target",
      sessionKey: "agent:main:target",
      message: {
        role: "assistant",
        timestamp: observedAt,
        content: [
          { type: "toolCall", id: "patch", name: "apply_patch", arguments: { input: patchInput } },
          { type: "toolCall", id: "profile", name: "write", arguments: { path: "USER.md" } },
          {
            type: "toolCall",
            id: "nested",
            name: "edit",
            input: { file_path: path.join(workspaceDir, "memory", "profile.md") },
          },
          {
            type: "toolCall",
            id: "structured",
            name: "apply_patch",
            arguments: { changes: [{ path: "memory/structured.md" }, { path: "README.md" }] },
          },
          { type: "toolCall", id: "ordinary", name: "write", arguments: { path: "README.md" } },
          { type: "toolCall", id: "escaping", name: "edit", arguments: { path: "../MEMORY.md" } },
          { type: "toolCall", id: "malformed", name: "apply_patch", arguments: { input: 42 } },
          { type: "toolCall", id: "read-only", name: "read", arguments: { path: "MEMORY.md" } },
          { type: "toolCall", id: "missing", name: "write", arguments: null },
          null,
        ],
      },
    });
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "survivor",
      sessionKey: "agent:main:survivor",
      message: {
        role: "assistant",
        timestamp: observedAt + 1,
        content: [
          {
            type: "toolCall",
            id: "unselected",
            name: "write",
            arguments: { path: "memory/keep.md" },
          },
        ],
      },
    });
    const archiveDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(archiveDir, { recursive: true });
    const archivedMessage = {
      type: "message",
      timestamp: new Date(observedAt + 1).toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "archived",
            name: "edit",
            input: { filePath: "memory/archive.md" },
          },
        ],
      },
    };
    await fs.writeFile(
      path.join(archiveDir, "target.jsonl.deleted.2026-08-26T12-35-00.000Z.zst"),
      zstdCompressSync(`${JSON.stringify(archivedMessage)}\n`),
    );
    expect(await listSessionTranscriptCorpusEntriesForAgent("main")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "target", artifactKind: "active-session" }),
        expect.objectContaining({ sessionId: "target", artifactKind: "archive-artifact" }),
      ]),
    );
    expect(await listMemoryArtifactProvenance({ workspaceDir })).toEqual([]);

    const preview = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["target"],
      dryRun: true,
    });

    expect(preview.curatedWrites).toEqual([
      { relativePath: "MEMORY.md", observedAt },
      { relativePath: "memory/archive.md", observedAt: observedAt + 1 },
      { relativePath: "memory/profile.md", observedAt },
      { relativePath: "memory/structured.md", observedAt },
      { relativePath: "USER.md", observedAt },
    ]);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(memoryContent);

    const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
    expect(report).toEqual({ ...preview, dryRun: false });
    expect(report.artifacts.memoryFiles).toBe(0);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(memoryContent);
  });
});
