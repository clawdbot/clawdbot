import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root as createFsSafeRoot } from "../infra/fs-safe.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { clearMemoryPluginState } from "../plugins/memory-state.test-fixtures.js";
import { listMemoryHostPublicArtifacts } from "./memory-host-core.js";
import {
  memoryHostEventExportOwnerContent,
  publishMemoryHostEventArtifact,
} from "./memory-host-event-export.js";
import { appendMemoryHostEvent } from "./memory-host-events.js";

describe("memory host event export recovery", () => {
  afterEach(() => {
    clearMemoryPluginState();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not finalize an initial export changed through the published inode", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-publish-race-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const relativePath = "memory/events/state/memory-host-events.jsonl";
    const ownerRelativePath = "memory/events/state/.openclaw-memory-host-events-owner.json";
    const absolutePath = path.join(workspaceDir, relativePath);
    const owner = {
      queueKey: "state\0workspace",
      lockTarget: path.join(fixtureRoot, "lock"),
      relativePath,
      ownerRelativePath,
      stateHash: "state",
      workspaceHash: "workspace",
    };
    const content = '{"type":"memory.recall.recorded","query":"�"}\n';
    const expectedBytes = Buffer.from(content, "utf8");
    const replacementBytes = Buffer.from("�", "utf8");
    const replacementOffset = expectedBytes.indexOf(replacementBytes);
    const foreignBytes = Buffer.concat([
      expectedBytes.subarray(0, replacementOffset),
      Buffer.from([0x80]),
      expectedBytes.subarray(replacementOffset + replacementBytes.length),
    ]);
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    const expectedOwnerContent = memoryHostEventExportOwnerContent(owner, {
      pendingSha256: contentSha256,
    });
    try {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, ownerRelativePath), expectedOwnerContent, "utf8");
      const workspaceRoot = await createFsSafeRoot(workspaceDir, {
        hardlinks: "reject",
        mkdir: true,
        mode: 0o600,
        symlinks: "reject",
      });
      const originalOpen = workspaceRoot.open.bind(workspaceRoot);
      let replacedContent = false;
      const interceptedWorkspaceRoot = new Proxy(workspaceRoot, {
        get(target, property, receiver) {
          if (property === "open") {
            return async (
              openedRelativePath: string,
              options?: Parameters<typeof workspaceRoot.open>[1],
            ) => {
              if (openedRelativePath === relativePath && !replacedContent) {
                replacedContent = true;
                await fs.writeFile(absolutePath, foreignBytes);
              }
              return await originalOpen(openedRelativePath, options);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await expect(
        publishMemoryHostEventArtifact({
          workspaceRoot: interceptedWorkspaceRoot,
          owner,
          absolutePath,
          expectedOwnerContent,
          content,
          contentSha256,
        }),
      ).resolves.toBeUndefined();
      expect(foreignBytes.toString("utf8")).toBe(content);
      await expect(fs.readFile(absolutePath)).resolves.toEqual(foreignBytes);
      expect(
        JSON.parse(await fs.readFile(path.join(workspaceDir, ownerRelativePath), "utf8")),
      ).toMatchObject({
        pendingContentSha256: contentSha256,
        fileDev: expect.any(String),
        fileIno: expect.any(String),
      });
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("finishes an inode-owned empty event export after interruption", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-inode-owner-"));
    const stateDir = path.join(fixtureRoot, "state");
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const event = {
      type: "memory.recall.recorded" as const,
      timestamp: "2026-05-18T12:00:00.000Z",
      query: "recover inode-owned export",
      resultCount: 0,
      results: [],
    };
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await fs.mkdir(workspaceDir);
      await appendMemoryHostEvent(workspaceDir, event);
      const stateHash = createHash("sha256")
        .update(await fs.realpath(stateDir))
        .digest("hex")
        .slice(0, 32);
      const workspaceHash = createHash("sha256")
        .update(await fs.realpath(workspaceDir))
        .digest("hex")
        .slice(0, 32);
      const exportDir = path.join(workspaceDir, "memory", "events", stateHash);
      const exportPath = path.join(exportDir, "memory-host-events.jsonl");
      const ownerPath = path.join(exportDir, ".openclaw-memory-host-events-owner.json");
      const expectedContent = `${JSON.stringify(event)}\n`;
      await fs.mkdir(exportDir, { recursive: true });
      await fs.writeFile(exportPath, "", { mode: 0o600 });
      const exportStat = await fs.stat(exportPath, { bigint: true });
      await fs.writeFile(
        ownerPath,
        `${JSON.stringify({
          schemaVersion: 3,
          kind: "openclaw-memory-host-events-export",
          stateHash,
          workspaceHash,
          pendingContentSha256: createHash("sha256").update(expectedContent).digest("hex"),
          fileDev: String(exportStat.dev),
          fileIno: String(exportStat.ino),
        })}\n`,
        "utf8",
      );

      const listed = await listMemoryHostPublicArtifacts({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
      });

      expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(true);
      await expect(fs.readFile(exportPath, "utf8")).resolves.toBe(expectedContent);
      const owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as {
        contentSha256?: string;
        fileDev?: string;
        fileIno?: string;
        pendingContentSha256?: string;
      };
      expect(owner).toMatchObject({
        contentSha256: createHash("sha256").update(expectedContent).digest("hex"),
        fileDev: expect.any(String),
        fileIno: expect.any(String),
      });
      expect(owner.pendingContentSha256).toBeUndefined();
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not claim an empty export after exclusive-create interruption", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-empty-export-"));
    const stateDir = path.join(fixtureRoot, "state");
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const event = {
      type: "memory.recall.recorded" as const,
      timestamp: "2026-05-18T12:00:00.000Z",
      query: "leave empty export untouched",
      resultCount: 0,
      results: [],
    };
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await fs.mkdir(workspaceDir);
      await appendMemoryHostEvent(workspaceDir, event);
      const stateHash = createHash("sha256")
        .update(await fs.realpath(stateDir))
        .digest("hex")
        .slice(0, 32);
      const workspaceHash = createHash("sha256")
        .update(await fs.realpath(workspaceDir))
        .digest("hex")
        .slice(0, 32);
      const exportDir = path.join(workspaceDir, "memory", "events", stateHash);
      const exportPath = path.join(exportDir, "memory-host-events.jsonl");
      const ownerPath = path.join(exportDir, ".openclaw-memory-host-events-owner.json");
      const expectedContent = `${JSON.stringify(event)}\n`;
      await fs.mkdir(exportDir, { recursive: true });
      await fs.writeFile(exportPath, "", { mode: 0o600 });
      await fs.writeFile(
        ownerPath,
        `${JSON.stringify({
          schemaVersion: 3,
          kind: "openclaw-memory-host-events-export",
          stateHash,
          workspaceHash,
          pendingContentSha256: createHash("sha256").update(expectedContent).digest("hex"),
        })}\n`,
        "utf8",
      );

      const listed = await listMemoryHostPublicArtifacts({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
      });

      expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.readFile(exportPath, "utf8")).resolves.toBe("");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
