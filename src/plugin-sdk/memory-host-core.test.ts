/**
 * Tests memory host core public artifact discovery and workspace handling.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  registerTestMemoryPromptBuilder,
} from "../plugins/memory-state.test-fixtures.js";
import {
  buildActiveMemoryPromptSection,
  listMemoryHostPublicArtifacts,
  listActiveMemoryPublicArtifacts,
} from "./memory-host-core.js";
import { appendMemoryHostEvent } from "./memory-host-events.js";

describe("memory-host-core helpers", () => {
  afterEach(() => {
    clearMemoryPluginState();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exposes the active memory prompt guidance builder for context engines", () => {
    registerTestMemoryPromptBuilder(({ citationsMode }) => [
      "## Memory Recall",
      `citations=${citationsMode ?? "default"}`,
      "",
    ]);

    expect(
      buildActiveMemoryPromptSection({
        availableTools: new Set(["memory_search"]),
        citationsMode: "off",
      }),
    ).toEqual(["## Memory Recall", "citations=off", ""]);
  });

  it("exposes active memory public artifacts for companion plugins", async () => {
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            {
              kind: "memory-root",
              workspaceDir: "/tmp/workspace",
              relativePath: "MEMORY.md",
              absolutePath: "/tmp/workspace/MEMORY.md",
              agentIds: ["main"],
              contentType: "markdown" as const,
            },
          ];
        },
      },
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
      {
        kind: "memory-root",
        workspaceDir: "/tmp/workspace",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/workspace/MEMORY.md",
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
  });

  it("propagates workspace inspection failures", async () => {
    vi.spyOn(fs, "stat").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );

    await expect(
      listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "main", default: true, workspace: "/protected/workspace" }],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("lists readable workspaces without requiring workspace-root writes", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-readonly-workspace-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
      await fs.mkdir(workspaceDir);
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Read-only memory\n", "utf8");
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "read-only",
        resultCount: 0,
        results: [],
      });
      await fs.chmod(workspaceDir, 0o500);

      await expect(
        listMemoryHostPublicArtifacts({
          cfg: {
            agents: {
              list: [{ id: "main", default: true, workspace: workspaceDir }],
            },
          },
        }),
      ).resolves.toMatchObject([
        {
          kind: "memory-root",
          workspaceDir,
          relativePath: "MEMORY.md",
        },
      ]);
    } finally {
      await fs.chmod(workspaceDir, 0o700).catch(() => undefined);
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "propagates failures reading an existing event export",
    async () => {
      const fixtureRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "memory-host-unreadable-export-"),
      );
      const workspaceDir = path.join(fixtureRoot, "workspace");
      let eventExportPath: string | undefined;
      try {
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
        await fs.mkdir(workspaceDir);
        await appendMemoryHostEvent(workspaceDir, {
          type: "memory.recall.recorded",
          timestamp: "2026-05-18T12:00:00.000Z",
          query: "unreadable export",
          resultCount: 0,
          results: [],
        });
        const firstListing = await listMemoryHostPublicArtifacts({
          cfg: {
            agents: {
              list: [{ id: "main", default: true, workspace: workspaceDir }],
            },
          },
        });
        eventExportPath = firstListing.find(
          (artifact) => artifact.kind === "event-log",
        )?.absolutePath;
        if (!eventExportPath) {
          throw new Error("expected memory event export");
        }
        await fs.chmod(eventExportPath, 0o000);

        await expect(
          listMemoryHostPublicArtifacts({
            cfg: {
              agents: {
                list: [{ id: "main", default: true, workspace: workspaceDir }],
              },
            },
          }),
        ).rejects.toThrow();
      } finally {
        if (eventExportPath) {
          await fs.chmod(eventExportPath, 0o600).catch(() => undefined);
        }
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not delete an event export through a symlinked parent",
    async () => {
      const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-export-symlink-"));
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const externalMemoryDir = path.join(fixtureRoot, "external-memory");
      const stateDir = path.join(fixtureRoot, "state");
      try {
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        await fs.mkdir(workspaceDir);
        await fs.mkdir(stateDir);
        const stateHash = createHash("sha256")
          .update(await fs.realpath(stateDir))
          .digest("hex")
          .slice(0, 32);
        const externalExport = path.join(
          externalMemoryDir,
          "events",
          stateHash,
          "memory-host-events.jsonl",
        );
        const externalOwner = path.join(
          path.dirname(externalExport),
          ".openclaw-memory-host-events-owner.json",
        );
        await fs.mkdir(path.dirname(externalExport), { recursive: true });
        await fs.writeFile(externalExport, '{"type":"external"}\n', "utf8");
        await fs.writeFile(externalOwner, '{"kind":"external"}\n', "utf8");
        await fs.symlink(externalMemoryDir, path.join(workspaceDir, "memory"));

        await expect(
          listMemoryHostPublicArtifacts({
            cfg: {
              agents: {
                list: [{ id: "main", default: true, workspace: workspaceDir }],
              },
            },
          }),
        ).resolves.toEqual([]);
        await expect(fs.readFile(externalExport, "utf8")).resolves.toBe('{"type":"external"}\n');
        await expect(fs.readFile(externalOwner, "utf8")).resolves.toBe('{"kind":"external"}\n');
      } finally {
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("does not replace or delete an unowned event export path", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-unowned-export-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
      await fs.mkdir(workspaceDir);
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "must not replace user file",
        resultCount: 0,
        results: [],
      });
      const stateHash = createHash("sha256")
        .update(await fs.realpath(fixtureRoot))
        .digest("hex")
        .slice(0, 32);
      const exportPath = path.join(
        workspaceDir,
        "memory",
        "events",
        stateHash,
        "memory-host-events.jsonl",
      );
      await fs.mkdir(path.dirname(exportPath), { recursive: true });
      await fs.writeFile(exportPath, '{"owner":"user"}\n', "utf8");

      const listed = await listMemoryHostPublicArtifacts({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
      });
      expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.readFile(exportPath, "utf8")).resolves.toBe('{"owner":"user"}\n');

      await createPluginStateKeyedStore("memory-core", {
        namespace: "memory-host.events",
        maxEntries: 10_000,
        env: { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot },
      }).clear();
      await listMemoryHostPublicArtifacts({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
      });
      await expect(fs.readFile(exportPath, "utf8")).resolves.toBe('{"owner":"user"}\n');
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not let an orphaned owner marker authorize a later workspace file", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-orphan-owner-"));
    const stateDir = path.join(fixtureRoot, "state");
    const workspaceDir = path.join(fixtureRoot, "workspace");
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await fs.mkdir(workspaceDir);
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "expected export",
        resultCount: 0,
        results: [],
      });
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
      const expectedContent = `${JSON.stringify({
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "expected export",
        resultCount: 0,
        results: [],
      })}\n`;
      await fs.mkdir(exportDir, { recursive: true });
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
      await fs.writeFile(exportPath, '{"owner":"user after crash"}\n', "utf8");

      const listed = await listMemoryHostPublicArtifacts({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
      });

      expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.readFile(exportPath, "utf8")).resolves.toBe('{"owner":"user after crash"}\n');
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not claim a same-content inode that replaces an exclusive export", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-create-replace-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
    const event = {
      type: "memory.recall.recorded" as const,
      timestamp: "2026-05-18T12:00:00.000Z",
      query: "exclusive create",
      resultCount: 0,
      results: [],
    };
    const expectedContent = `${JSON.stringify(event)}\n`;
    const originalOpen = fs.open.bind(fs);
    let exportOpenCount = 0;
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
      await fs.mkdir(workspaceDir, { recursive: true });
      await appendMemoryHostEvent(workspaceDir, event);
      const stateHash = createHash("sha256")
        .update(await fs.realpath(fixtureRoot))
        .digest("hex")
        .slice(0, 32);
      const exportPath = path.join(
        workspaceDir,
        "memory",
        "events",
        stateHash,
        "memory-host-events.jsonl",
      );
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const target = args[0];
        if (typeof target === "string" && path.resolve(target) === path.resolve(exportPath)) {
          exportOpenCount += 1;
          if (exportOpenCount === 4) {
            await fs.rename(exportPath, `${exportPath}.openclaw-created`);
            const replacement = await originalOpen(exportPath, "wx", 0o600);
            try {
              await replacement.writeFile(expectedContent, "utf8");
            } finally {
              await replacement.close();
            }
          }
        }
        return await originalOpen(...args);
      });

      const racedArtifacts = await listMemoryHostPublicArtifacts({ cfg });
      expect(racedArtifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.readFile(exportPath, "utf8")).resolves.toBe(expectedContent);

      vi.restoreAllMocks();
      await appendMemoryHostEvent(workspaceDir, { ...event, query: "must stay foreign" });
      const retriedArtifacts = await listMemoryHostPublicArtifacts({ cfg });
      expect(retriedArtifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.readFile(exportPath, "utf8")).resolves.toBe(expectedContent);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not claim a hash-only pending event export after interruption", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-pending-owner-"));
    const stateDir = path.join(fixtureRoot, "state");
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const firstEvent = {
      type: "memory.recall.recorded" as const,
      timestamp: "2026-05-18T12:00:00.000Z",
      query: "pending export",
      resultCount: 0,
      results: [],
    };
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      await fs.mkdir(workspaceDir);
      await appendMemoryHostEvent(workspaceDir, firstEvent);
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
      const pendingContent = `${JSON.stringify(firstEvent)}\n`;
      await fs.mkdir(exportDir, { recursive: true });
      await fs.writeFile(exportPath, pendingContent, "utf8");
      await fs.writeFile(
        ownerPath,
        `${JSON.stringify({
          schemaVersion: 3,
          kind: "openclaw-memory-host-events-export",
          stateHash,
          workspaceHash,
          pendingContentSha256: createHash("sha256").update(pendingContent).digest("hex"),
        })}\n`,
        "utf8",
      );
      await appendMemoryHostEvent(workspaceDir, {
        ...firstEvent,
        timestamp: "2026-05-18T12:01:00.000Z",
        query: "after interruption",
      });

      const listed = await listMemoryHostPublicArtifacts({
        cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
      });

      expect(listed.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.readFile(exportPath, "utf8")).resolves.toBe(pendingContent);
      const owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as {
        contentSha256?: string;
        fileDev?: string;
        fileIno?: string;
        pendingContentSha256?: string;
      };
      expect(owner.pendingContentSha256).toBe(
        createHash("sha256")
          .update(await fs.readFile(exportPath))
          .digest("hex"),
      );
      expect(owner.contentSha256).toBeUndefined();
      expect(owner.fileDev).toBeUndefined();
      expect(owner.fileIno).toBeUndefined();
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("omits the event export when a workspace path component is a file", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-blocked-export-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
      await fs.mkdir(workspaceDir);
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Still visible\n", "utf8");
      await fs.writeFile(path.join(workspaceDir, "memory"), "user file\n", "utf8");
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "blocked export",
        resultCount: 0,
        results: [],
      });

      await expect(
        listMemoryHostPublicArtifacts({
          cfg: { agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] } },
        }),
      ).resolves.toEqual([
        expect.objectContaining({ kind: "memory-root", relativePath: "MEMORY.md" }),
      ]);
      await expect(fs.readFile(path.join(workspaceDir, "memory"), "utf8")).resolves.toBe(
        "user file\n",
      );
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("lists shared public artifacts from memory workspaces", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-public-artifacts-"));
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
      const workspaceDir = path.join(fixtureRoot, "workspace");
      await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
      await fs.writeFile(
        path.join(workspaceDir, "memory", "2026-05-18.md"),
        "# Daily Note\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(workspaceDir, "memory", "dreaming", "2026-05-18.md"),
        "# Dream Report\n",
        "utf8",
      );
      const eventStoredAt = Date.parse("2026-05-19T09:30:00.000Z");
      vi.spyOn(Date, "now").mockReturnValue(eventStoredAt);
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "bridge",
        resultCount: 0,
        results: [],
      });

      const artifacts = await listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "main", default: true, workspace: workspaceDir }],
          },
        },
      });
      const eventArtifact = artifacts.find((artifact) => artifact.kind === "event-log");
      if (!eventArtifact) {
        throw new Error("expected memory event export");
      }
      expect(artifacts.filter((artifact) => artifact.kind !== "event-log")).toEqual([
        {
          kind: "memory-root",
          workspaceDir,
          relativePath: "MEMORY.md",
          absolutePath: path.join(workspaceDir, "MEMORY.md"),
          agentIds: ["main"],
          contentType: "markdown",
        },
        {
          kind: "daily-note",
          workspaceDir,
          relativePath: "memory/2026-05-18.md",
          absolutePath: path.join(workspaceDir, "memory", "2026-05-18.md"),
          agentIds: ["main"],
          contentType: "markdown",
        },
        {
          kind: "dream-report",
          workspaceDir,
          relativePath: "memory/dreaming/2026-05-18.md",
          absolutePath: path.join(workspaceDir, "memory", "dreaming", "2026-05-18.md"),
          agentIds: ["main"],
          contentType: "markdown",
        },
      ]);
      expect(eventArtifact).toMatchObject({
        kind: "event-log",
        workspaceDir,
        agentIds: ["main"],
        contentType: "json",
      });
      expect(eventArtifact.relativePath).toMatch(
        /^memory\/events\/[a-f0-9]{32}\/memory-host-events\.jsonl$/u,
      );
      expect(eventArtifact.absolutePath).toBe(
        path.join(workspaceDir, ...eventArtifact.relativePath.split("/")),
      );
      const eventExportPath = eventArtifact.absolutePath;
      await expect(fs.readFile(eventExportPath, "utf8")).resolves.toBe(
        `${JSON.stringify({
          type: "memory.recall.recorded",
          timestamp: "2026-05-18T12:00:00.000Z",
          query: "bridge",
          resultCount: 0,
          results: [],
        })}\n`,
      );
      const exportStat = await fs.stat(eventExportPath);
      const exportOwner = JSON.parse(
        await fs.readFile(
          path.join(path.dirname(eventExportPath), ".openclaw-memory-host-events-owner.json"),
          "utf8",
        ),
      ) as { fileDev?: string; fileIno?: string };
      expect(exportOwner.fileDev).toBe(String(exportStat.dev));
      expect(exportOwner.fileIno).toBe(String(exportStat.ino));
      await expect(
        fs.access(path.join(workspaceDir, ".memory-host-events-export.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(fixtureRoot)).some((entry) =>
          entry.startsWith(".memory-host-events-export-"),
        ),
      ).toBe(false);

      await createPluginStateKeyedStore("memory-core", {
        namespace: "memory-host.events",
        maxEntries: 10_000,
        env: { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot },
      }).clear();
      const afterRetention = await listMemoryHostPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "main", default: true, workspace: workspaceDir }],
          },
        },
      });
      expect(afterRetention.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.readFile(eventExportPath, "utf8")).resolves.toBe("");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not let a workspace alias overwrite a newer event export",
    async () => {
      const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-export-race-"));
      const workspaceDir = path.join(fixtureRoot, "workspace");
      const workspaceAlias = path.join(fixtureRoot, "workspace-alias");
      const cfg = {
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
      };
      const aliasCfg = {
        agents: { list: [{ id: "main", default: true, workspace: workspaceAlias }] },
      };
      const originalOpen = fs.open.bind(fs);
      let releaseFirstRead: (() => void) | undefined;
      let signalFirstRead: (() => void) | undefined;
      let shouldBlockFirstRead = true;
      const firstReadStarted = new Promise<void>((resolve) => {
        signalFirstRead = resolve;
      });
      const openSpy = vi
        .spyOn(fs, "open")
        .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const target = args[0];
          if (
            shouldBlockFirstRead &&
            typeof target === "string" &&
            path.basename(target) === "memory-host-events.jsonl" &&
            path.resolve(target).startsWith(`${path.resolve(workspaceDir)}${path.sep}`)
          ) {
            shouldBlockFirstRead = false;
            signalFirstRead?.();
            await new Promise<void>((resolve) => {
              releaseFirstRead = resolve;
            });
          }
          return await originalOpen(...args);
        });

      try {
        vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.symlink(workspaceDir, workspaceAlias);
        await appendMemoryHostEvent(workspaceAlias, {
          type: "memory.recall.recorded",
          timestamp: "2026-05-18T12:00:00.000Z",
          query: "older",
          resultCount: 0,
          results: [],
        });
        const olderListing = listMemoryHostPublicArtifacts({ cfg });
        await firstReadStarted;

        await appendMemoryHostEvent(workspaceDir, {
          type: "memory.recall.recorded",
          timestamp: "2026-05-18T12:01:00.000Z",
          query: "newer",
          resultCount: 0,
          results: [],
        });
        const newerListing = listMemoryHostPublicArtifacts({ cfg: aliasCfg });
        await Promise.race([
          newerListing,
          new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
          }),
        ]);
        releaseFirstRead?.();
        const [olderArtifacts, newerArtifacts] = await Promise.all([olderListing, newerListing]);
        const olderExport = olderArtifacts.find((artifact) => artifact.kind === "event-log");
        const newerExport = newerArtifacts.find((artifact) => artifact.kind === "event-log");
        expect(olderExport?.absolutePath).toBe(newerExport?.absolutePath);
        const eventExportPath = newerExport?.absolutePath;
        if (!eventExportPath) {
          throw new Error("expected memory event export");
        }

        const exported = (await fs.readFile(eventExportPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { query: string });
        expect(exported.map((event) => event.query)).toEqual(["older", "newer"]);
      } finally {
        releaseFirstRead?.();
        openSpy.mockRestore();
        await fs.rm(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: "refresh", clearEvents: false },
    { name: "retirement", clearEvents: true },
  ])("preserves a replacement installed during event export $name", async ({ clearEvents }) => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-export-replace-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
    const replacement = '{"owner":"workspace"}\n';
    const originalOpen = fs.open.bind(fs);
    let exportOpenCount = 0;
    let eventExportPath: string | undefined;
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
      await fs.mkdir(workspaceDir, { recursive: true });
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "first",
        resultCount: 0,
        results: [],
      });
      eventExportPath = (await listMemoryHostPublicArtifacts({ cfg })).find(
        (artifact) => artifact.kind === "event-log",
      )?.absolutePath;
      if (!eventExportPath) {
        throw new Error("expected memory event export");
      }
      if (clearEvents) {
        await createPluginStateKeyedStore("memory-core", {
          namespace: "memory-host.events",
          maxEntries: 10_000,
          env: { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot },
        }).clear();
      } else {
        await appendMemoryHostEvent(workspaceDir, {
          type: "memory.recall.recorded",
          timestamp: "2026-05-18T12:01:00.000Z",
          query: "second",
          resultCount: 0,
          results: [],
        });
      }

      const expectedExportPath = path.resolve(eventExportPath);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const target = args[0];
        if (typeof target === "string" && path.resolve(target) === expectedExportPath) {
          exportOpenCount += 1;
          if (exportOpenCount === 2) {
            await fs.rename(expectedExportPath, `${expectedExportPath}.openclaw-owned`);
            await fs.writeFile(expectedExportPath, replacement, "utf8");
          }
        }
        return await originalOpen(...args);
      });

      const artifacts = await listMemoryHostPublicArtifacts({ cfg });
      expect(artifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
      await expect(fs.readFile(expectedExportPath, "utf8")).resolves.toBe(replacement);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "refresh", clearEvents: false },
    { name: "retirement", clearEvents: true },
  ])("keeps ownership through same-inode event export $name", async ({ clearEvents }) => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-export-inode-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
    const originalOpen = fs.open.bind(fs);
    let exportOpenCount = 0;
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
      await fs.mkdir(workspaceDir, { recursive: true });
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "first",
        resultCount: 0,
        results: [],
      });
      const eventExportPath = (await listMemoryHostPublicArtifacts({ cfg })).find(
        (artifact) => artifact.kind === "event-log",
      )?.absolutePath;
      if (!eventExportPath) {
        throw new Error("expected memory event export");
      }
      if (clearEvents) {
        await createPluginStateKeyedStore("memory-core", {
          namespace: "memory-host.events",
          maxEntries: 10_000,
          env: { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot },
        }).clear();
      } else {
        await appendMemoryHostEvent(workspaceDir, {
          type: "memory.recall.recorded",
          timestamp: "2026-05-18T12:01:00.000Z",
          query: "second",
          resultCount: 0,
          results: [],
        });
      }

      const expectedExportPath = path.resolve(eventExportPath);
      const originalStat = await fs.stat(expectedExportPath);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const target = args[0];
        if (typeof target === "string" && path.resolve(target) === expectedExportPath) {
          exportOpenCount += 1;
          if (exportOpenCount === 2) {
            const writer = await originalOpen(expectedExportPath, "w");
            try {
              await writer.writeFile('{"owner":"same inode"}\n', "utf8");
            } finally {
              await writer.close();
            }
          }
        }
        return await originalOpen(...args);
      });

      const artifacts = await listMemoryHostPublicArtifacts({ cfg });
      expect((await fs.stat(expectedExportPath)).ino).toBe(originalStat.ino);
      if (clearEvents) {
        expect(artifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
        await expect(fs.readFile(expectedExportPath, "utf8")).resolves.toBe("");
      } else {
        expect(artifacts.some((artifact) => artifact.kind === "event-log")).toBe(true);
        await expect(fs.readFile(expectedExportPath, "utf8")).resolves.toContain("second");
      }
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("retries an owned event export after a same-inode post-write race", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-export-retry-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
    const originalOpen = fs.open.bind(fs);
    let exportOpenCount = 0;
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
      await fs.mkdir(workspaceDir, { recursive: true });
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "first",
        resultCount: 0,
        results: [],
      });
      const eventExportPath = (await listMemoryHostPublicArtifacts({ cfg })).find(
        (artifact) => artifact.kind === "event-log",
      )?.absolutePath;
      if (!eventExportPath) {
        throw new Error("expected memory event export");
      }
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:01:00.000Z",
        query: "second",
        resultCount: 0,
        results: [],
      });

      const expectedExportPath = path.resolve(eventExportPath);
      const openSpy = vi
        .spyOn(fs, "open")
        .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const target = args[0];
          if (typeof target === "string" && path.resolve(target) === expectedExportPath) {
            exportOpenCount += 1;
            if (exportOpenCount === 4) {
              const writer = await originalOpen(expectedExportPath, "w");
              try {
                await writer.writeFile('{"owner":"post-write race"}\n', "utf8");
              } finally {
                await writer.close();
              }
            }
          }
          return await originalOpen(...args);
        });

      const racedArtifacts = await listMemoryHostPublicArtifacts({ cfg });
      expect(racedArtifacts.some((artifact) => artifact.kind === "event-log")).toBe(false);
      openSpy.mockRestore();

      const retriedArtifacts = await listMemoryHostPublicArtifacts({ cfg });
      expect(retriedArtifacts.some((artifact) => artifact.kind === "event-log")).toBe(true);
      await expect(fs.readFile(expectedExportPath, "utf8")).resolves.toContain("second");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("repairs an oversized owned event export by inode", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-export-oversized-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", fixtureRoot);
      await fs.mkdir(workspaceDir, { recursive: true });
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:00:00.000Z",
        query: "first",
        resultCount: 0,
        results: [],
      });
      const eventExportPath = (await listMemoryHostPublicArtifacts({ cfg })).find(
        (artifact) => artifact.kind === "event-log",
      )?.absolutePath;
      if (!eventExportPath) {
        throw new Error("expected memory event export");
      }
      const originalStat = await fs.stat(eventExportPath);
      await fs.appendFile(eventExportPath, "x".repeat(1024 * 1024 + 1), "utf8");
      await appendMemoryHostEvent(workspaceDir, {
        type: "memory.recall.recorded",
        timestamp: "2026-05-18T12:01:00.000Z",
        query: "second",
        resultCount: 0,
        results: [],
      });

      const artifacts = await listMemoryHostPublicArtifacts({ cfg });
      expect(artifacts.some((artifact) => artifact.kind === "event-log")).toBe(true);
      expect((await fs.stat(eventExportPath)).ino).toBe(originalStat.ino);
      expect((await fs.stat(eventExportPath)).size).toBeLessThan(1024 * 1024);
      await expect(fs.readFile(eventExportPath, "utf8")).resolves.toContain("second");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps public event exports isolated across state directories", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-export-owner-"));
    const workspaceDir = path.join(fixtureRoot, "workspace");
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
    try {
      await fs.mkdir(workspaceDir, { recursive: true });

      const exports: string[] = [];
      for (const profile of ["profile-a", "profile-b"]) {
        vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, profile));
        await appendMemoryHostEvent(workspaceDir, {
          type: "memory.recall.recorded",
          timestamp: "2026-05-18T12:00:00.000Z",
          query: profile,
          resultCount: 0,
          results: [],
        });
        const artifact = (await listMemoryHostPublicArtifacts({ cfg })).find(
          (candidate) => candidate.kind === "event-log",
        );
        if (!artifact) {
          throw new Error("expected memory event export");
        }
        exports.push(artifact.absolutePath);
        await expect(fs.readFile(artifact.absolutePath, "utf8")).resolves.toContain(profile);
      }

      expect(new Set(exports).size).toBe(2);
      const [profileAExport, profileBExport] = exports;
      if (!profileAExport || !profileBExport) {
        throw new Error("expected state-qualified memory event exports");
      }
      await expect(fs.readFile(profileAExport, "utf8")).resolves.toContain("profile-a");
      await expect(fs.readFile(profileBExport, "utf8")).resolves.toContain("profile-b");
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
