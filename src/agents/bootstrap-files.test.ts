/** Tests agent bootstrap file discovery, filtering, and injected context modes. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  upsertSessionEntry,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE,
  hasCompletedBootstrapTurn,
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
  resolveContextInjectionMode,
} from "./bootstrap-files.js";
import { SessionManager } from "./sessions/session-manager.js";
import { resetLegacyWorkspaceStateCheckForTest } from "./workspace-legacy-state.test-support.js";
import { mergeWorkspaceSetupState } from "./workspace-state-store.js";
import {
  DEFAULT_MEMORY_FILENAME,
  loadExtraBootstrapFilesWithDiagnostics,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

let testState: OpenClawTestState | undefined;

function registerExtraBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        path: path.join(context.workspaceDir, "EXTRA.md"),
        content: "extra",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

function registerMalformedBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    // Hook contracts are extension-facing; malformed entries must warn and drop
    // without breaking normal project bootstrap files.
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        filePath: path.join(context.workspaceDir, "BROKEN.md"),
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: 123,
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: "   ",
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

function registerDuplicateBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    // Duplicates exercise canonical path dedupe between relative hook entries
    // and resolved workspace files.
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "AGENTS.md",
        path: "AGENTS.md",
        content: "duplicate relative hook content",
        missing: false,
      },
      {
        name: "AGENTS.md",
        path: path.join(context.workspaceDir, ".", "AGENTS.md"),
        content: "duplicate absolute hook content",
        missing: false,
      },
    ];
  });
}

function registerNamedBootstrapFileHook(
  relativePath = "MEMORY.md",
  name: WorkspaceBootstrapFile["name"] = "MEMORY.md",
) {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name,
        path: path.join(context.workspaceDir, relativePath),
        content: "hook memory",
        missing: false,
      },
    ];
  });
}

function registerLoadedBootstrapFilesHook(
  relativePaths: string[],
  name?: WorkspaceBootstrapFile["name"],
) {
  registerInternalHook("agent:bootstrap", async (event) => {
    const context = event.context as AgentBootstrapHookContext;
    const { files } = await loadExtraBootstrapFilesWithDiagnostics(
      context.workspaceDir,
      relativePaths,
    );
    if (name) {
      for (const file of files) {
        file.name = name;
      }
    }
    context.bootstrapFiles = [...context.bootstrapFiles, ...files];
  });
}

async function createDirectoryAlias(params: {
  workspaceDir: string;
  targetDir: string;
  aliasName: string;
}): Promise<string> {
  const aliasDir = path.join(params.workspaceDir, params.aliasName);
  await fs.symlink(params.targetDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
  return aliasDir;
}

function registerBootstrapFileHook(relativePath = "BOOTSTRAP.md") {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "BOOTSTRAP.md",
        path: path.join(context.workspaceDir, relativePath),
        content: "stale ritual",
        missing: false,
      },
    ];
  });
}

async function createHeartbeatAgentsWorkspace() {
  const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
  await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "repo rules", "utf8");
  return workspaceDir;
}

async function writeCompletedWorkspaceState(workspaceDir: string): Promise<void> {
  mergeWorkspaceSetupState(workspaceDir, {
    bootstrapSeededAt: "2026-05-16T00:00:00.000Z",
    setupCompletedAt: "2026-05-16T00:00:01.000Z",
  });
}

async function writeLegacyCompletedWorkspaceState(workspaceDir: string): Promise<void> {
  await fs.mkdir(path.join(workspaceDir, ".openclaw"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, ".openclaw", "workspace-state.json"),
    `${JSON.stringify({
      version: 1,
      bootstrapSeededAt: "2026-05-16T00:00:00.000Z",
      setupCompletedAt: "2026-05-16T00:00:01.000Z",
    })}\n`,
    "utf8",
  );
}

function expectHeartbeatExcludedAndAgentsKept(files: WorkspaceBootstrapFile[]) {
  // Heartbeat policy can remove HEARTBEAT.md for normal turns, but project rules
  // must remain in the bootstrap set.
  const fileNames = files.map((file) => file.name);
  expect(fileNames).not.toContain("HEARTBEAT.md");
  expect(fileNames).toContain("AGENTS.md");
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(async () => {
    clearInternalHooks();
    resetLegacyWorkspaceStateCheckForTest();
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-bootstrap-state-",
    });
  });
  afterEach(async () => {
    clearInternalHooks();
    closeOpenClawStateDatabaseForTest();
    resetLegacyWorkspaceStateCheckForTest();
    await testState?.cleanup();
    testState = undefined;
  });

  it("applies bootstrap hook overrides", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    const filePaths = files.map((file) => file.path);
    expect(filePaths).toContain(path.join(workspaceDir, "EXTRA.md"));
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerMalformedBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "BOOTSTRAP.md",
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });

  it("dedupes hook-injected bootstrap paths relative to the workspace", async () => {
    registerDuplicateBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(agentsPath, "workspace rules", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const agentsFiles = files.filter((file) => file.path === agentsPath);

    expect(agentsFiles).toHaveLength(1);
    expect(agentsFiles[0]?.content).toBe("workspace rules");

    const context = await resolveBootstrapContextForRun({ workspaceDir });
    const agentsContextFiles = context.contextFiles.filter((file) => file.path === agentsPath);
    expect(agentsContextFiles).toHaveLength(1);
    expect(agentsContextFiles[0]?.content).toBe("workspace rules");
  });

  it("ignores stale workspace BOOTSTRAP.md once setup is completed", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await writeCompletedWorkspaceState(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => file.name)).toContain("AGENTS.md");
    expect(files.map((file) => file.name)).not.toContain("BOOTSTRAP.md");
  });

  it("treats USER.md as optional", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => file.name)).not.toContain("USER.md");
  });

  it("refreshes USER.md on every turn for long-lived sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const userPath = path.join(workspaceDir, "USER.md");
    const sessionKey = `agent:main:webchat:direct:${randomUUID()}`;
    await fs.writeFile(userPath, "Prefer concise answers.", "utf8");
    const first = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

    await fs.writeFile(userPath, "Prefer detailed answers.", "utf8");
    const second = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

    expect(first.find((file) => file.name === "USER.md")?.content).toBe("Prefer concise answers.");
    expect(second.find((file) => file.name === "USER.md")?.content).toBe(
      "Prefer detailed answers.",
    );
  });

  it("keeps BOOTSTRAP.md until Doctor migrates legacy setup state", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await writeLegacyCompletedWorkspaceState(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => file.name)).toContain("AGENTS.md");
    expect(files.map((file) => file.name)).toContain("BOOTSTRAP.md");
  });

  it("keeps BOOTSTRAP.md when current setup state cannot be read", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.mkdir(path.join(workspaceDir, "openclaw-workspace-state.json"), {
      recursive: true,
    });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => file.name)).toContain("BOOTSTRAP.md");
  });

  it("does not let hooks re-add stale root BOOTSTRAP.md after setup is completed", async () => {
    registerBootstrapFileHook();
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await writeCompletedWorkspaceState(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => file.name)).not.toContain("BOOTSTRAP.md");
  });

  it("ignores stale root BOOTSTRAP.md for home-relative workspace paths", async () => {
    registerBootstrapFileHook();
    const parentDir = await makeTempWorkspace("openclaw-bootstrap-home-");
    const workspaceDir = path.join(parentDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeCompletedWorkspaceState(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");

    const files = await withEnvAsync({ OPENCLAW_HOME: parentDir }, async () =>
      resolveBootstrapFilesForRun({ workspaceDir: "~/workspace" }),
    );

    expect(files.map((file) => file.name)).toContain("AGENTS.md");
    expect(files.map((file) => file.name)).not.toContain("BOOTSTRAP.md");
  });

  it("keeps hook-added nested BOOTSTRAP.md after setup is completed", async () => {
    registerBootstrapFileHook(path.join("packages", "core", "BOOTSTRAP.md"));
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.mkdir(path.join(workspaceDir, "packages", "core"), { recursive: true });
    await writeCompletedWorkspaceState(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "stale ritual", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "packages", "core", "BOOTSTRAP.md"),
      "package ritual",
      "utf8",
    );

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toContain(
      path.join("packages", "core", "BOOTSTRAP.md"),
    );
    expect(files.map((file) => file.path)).not.toContain(path.join(workspaceDir, "BOOTSTRAP.md"));
  });

  it("keeps MEMORY.md for direct sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-direct-");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "private memory", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:discord:direct:user-1",
    });

    expect(files.map((file) => file.name)).toContain("MEMORY.md");
  });

  it.each(["group", "channel"] as const)(
    "drops MEMORY.md for an opaque session with authoritative %s chat type",
    async (chatType) => {
      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-shared-");
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "private memory", "utf8");

      const files = await resolveBootstrapFilesForRun({
        workspaceDir,
        sessionKey: "agent:main:opaque:binding",
        chatType,
      });

      expect(files.map((file) => file.name)).not.toContain("MEMORY.md");
    },
  );

  it.each(["direct", "group", "channel"] as const)(
    "applies root-memory source privacy while keeping unrelated aliases for %s chats",
    async (chatType) => {
      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-shared-alias-");
      const nestedDir = path.join(workspaceDir, "packages", "core");
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, DEFAULT_MEMORY_FILENAME),
        "private memory",
        "utf8",
      );
      await fs.writeFile(path.join(nestedDir, DEFAULT_MEMORY_FILENAME), "nested memory", "utf8");
      const rootAliasDir = await createDirectoryAlias({
        workspaceDir,
        targetDir: workspaceDir,
        aliasName: "root-memory-alias",
      });
      const nestedAliasDir = await createDirectoryAlias({
        workspaceDir,
        targetDir: nestedDir,
        aliasName: "nested-memory-alias",
      });
      const rootAliasPath = path.join(rootAliasDir, DEFAULT_MEMORY_FILENAME);
      const nestedAliasPath = path.join(nestedAliasDir, DEFAULT_MEMORY_FILENAME);
      registerLoadedBootstrapFilesHook([
        path.relative(workspaceDir, rootAliasPath),
        path.relative(workspaceDir, nestedAliasPath),
      ]);

      const files = await resolveBootstrapFilesForRun({
        workspaceDir,
        sessionKey: "agent:main:opaque:binding",
        chatType,
      });

      if (chatType === "direct") {
        expect(files.map((file) => file.path)).toContain(rootAliasPath);
      } else {
        expect(files.map((file) => file.path)).not.toContain(rootAliasPath);
      }
      expect(files.map((file) => file.path)).toContain(nestedAliasPath);
    },
  );

  it("does not let hooks re-add MEMORY.md to shared sessions", async () => {
    registerNamedBootstrapFileHook();
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-hook-shared-");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "private memory", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:slack:channel:c1",
    });

    expect(files.map((file) => file.name)).not.toContain("MEMORY.md");
  });

  it("does not let hooks relabel and re-add root MEMORY.md to shared sessions", async () => {
    registerNamedBootstrapFileHook("MEMORY.md", "SOUL.md");
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-hook-shared-alias-");
    const rootMemoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(rootMemoryPath, "private memory", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:slack:channel:c1",
    });

    expect(files.map((file) => file.path)).not.toContain(rootMemoryPath);
  });

  it("keeps hook-added nested MEMORY.md in shared sessions", async () => {
    registerNamedBootstrapFileHook(path.join("packages", "core", "MEMORY.md"));
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-hook-nested-memory-");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:slack:channel:c1",
    });

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toContain(
      path.join("packages", "core", "MEMORY.md"),
    );
  });

  it("keeps missing hook records without source identity when policy allows them", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-missing-hook-record-");
    await fs.writeFile(path.join(workspaceDir, DEFAULT_MEMORY_FILENAME), "private memory", "utf8");
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "SOUL.md",
          path: path.join(context.workspaceDir, "generated", "SOUL.md"),
          missing: true,
        },
      ];
    });

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      sessionKey: "agent:main:opaque:binding",
      chatType: "channel",
    });

    expect(files).toContainEqual({
      name: "SOUL.md",
      path: path.join(workspaceDir, "generated", "SOUL.md"),
      missing: true,
    });
  });

  it.each([
    {
      mode: "subagent",
      sessionKey: "agent:main:subagent:worker",
      relabeledName: "AGENTS.md",
      expectedNames: ["AGENTS.md"],
    },
    {
      mode: "cron",
      sessionKey: "agent:main:cron:daily:run:run-1",
      relabeledName: "SOUL.md",
      expectedNames: ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"],
    },
  ] as const)(
    "rejects loader aliases to root memory relabeled under the $mode allowlist",
    async ({ sessionKey, relabeledName, expectedNames }) => {
      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-restricted-");
      const rootMemoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);
      const aliasDir = await createDirectoryAlias({
        workspaceDir,
        targetDir: workspaceDir,
        aliasName: "root-memory-alias",
      });
      registerLoadedBootstrapFilesHook(
        [path.relative(workspaceDir, path.join(aliasDir, DEFAULT_MEMORY_FILENAME))],
        relabeledName,
      );
      await Promise.all(
        [
          ["AGENTS.md", "project rules"],
          ["SOUL.md", "persona"],
          ["IDENTITY.md", "identity"],
          ["USER.md", "user profile"],
          ["MEMORY.md", "memory"],
          ["HEARTBEAT.md", "heartbeat"],
          ["BOOTSTRAP.md", "setup"],
        ].map(([fileName, content]) =>
          fs.writeFile(
            path.join(workspaceDir, expectDefined(fileName, "fileName test invariant")),
            expectDefined(content, "content test invariant"),
            "utf8",
          ),
        ),
      );

      const files = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

      expect(files.map((file) => file.name)).toStrictEqual(expectedNames);
      expect(files.map((file) => file.path)).not.toContain(rootMemoryPath);
    },
  );
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });

  it("keeps BOOTSTRAP.md available in shared injected context for non-attempt consumers", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "rules", "utf8");

    const result = await resolveBootstrapContextForRun({ workspaceDir });

    const bootstrapFileNames = result.bootstrapFiles.map((file) => file.name);
    expect(bootstrapFileNames).toContain("BOOTSTRAP.md");
    const contextFileNames = new Set(result.contextFiles.map((file) => path.basename(file.path)));
    expect(contextFileNames.has("BOOTSTRAP.md")).toBe(true);
    expect(contextFileNames.has("AGENTS.md")).toBe(true);
  });

  it("keeps bootstrap context empty in lightweight heartbeat mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "persona", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "heartbeat",
    });

    // Heartbeat context comes from cron scratch via the heartbeat runner now.
    expect(files).toStrictEqual([]);
  });

  it("keeps bootstrap context empty in lightweight cron mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "cron",
    });

    expect(files).toStrictEqual([]);
  });

  it("never re-imports a leftover workspace HEARTBEAT.md into bootstrap context", async () => {
    const workspaceDir = await createHeartbeatAgentsWorkspace();

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      runKind: "heartbeat",
      config: {
        agents: {
          defaults: { heartbeat: {} },
          list: [{ id: "main" }],
        },
      },
    });

    expectHeartbeatExcludedAndAgentsKept(files);
  });
});

describe("hasCompletedBootstrapTurn", () => {
  let tmpDir: string;
  let sessionTarget: SessionTranscriptRuntimeTarget;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "openclaw-bootstrap-turn-"));
    sessionTarget = {
      agentId: "main",
      sessionId: randomUUID(),
      sessionKey: "agent:main:bootstrap-turn",
      storePath: path.join(tmpDir, "sessions.json"),
    };
    await upsertSessionEntry(sessionTarget, {
      sessionId: sessionTarget.sessionId,
      updatedAt: Date.now(),
    });
    sessionManager = SessionManager.open(sessionTarget, tmpDir);
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false without a complete SQLite transcript identity", async () => {
    expect(await hasCompletedBootstrapTurn()).toBe(false);
    expect(await hasCompletedBootstrapTurn({ ...sessionTarget, storePath: undefined })).toBe(false);
  });

  it("returns false when the SQLite session has no transcript", async () => {
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });

  it("returns false when no full bootstrap marker has been recorded", async () => {
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sessionManager.appendCustomEntry("openclaw:unrelated", { timestamp: 2 });

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });

  it("reads a completion marker persisted by the SQLite session manager", async () => {
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(true);
  });

  it("invalidates a completion marker after compaction", async () => {
    const firstEntryId = sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    sessionManager.appendCompaction("trimmed", firstEntryId, 10);

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });

  it("accepts a newer full bootstrap marker after compaction", async () => {
    const firstEntryId = sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    sessionManager.appendCompaction("trimmed", firstEntryId, 10);
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 3 });

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(true);
  });

  it("invalidates a completion marker after a session reset", async () => {
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    sessionManager.appendResetBoundary("reset");

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });

  it("accepts a newer full bootstrap marker after a session reset", async () => {
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    sessionManager.appendResetBoundary("reset");
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 3 });

    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(true);
  });

  it("ignores completion markers on an inactive transcript branch", async () => {
    const firstEntryId = sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    sessionManager.appendCustomEntry(FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE, { timestamp: 2 });
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(true);

    sessionManager.appendLeafControl({
      targetId: firstEntryId,
      appendParentId: firstEntryId,
    });
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
  });
});

describe("makeBootstrapWarn", () => {
  it("deduplicates repeated warnings for the same session and message", () => {
    const warnings: string[] = [];
    const warn = makeBootstrapWarn({
      sessionLabel: "agent:main:test-session",
      workspaceDir: `/tmp/${randomUUID()}`,
      warn: (message) => warnings.push(message),
    });

    warn?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");
    warn?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");

    expect(warnings).toEqual([
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:test-session)",
    ]);
  });

  it("keeps warnings distinct across sessions", () => {
    const warnings: string[] = [];
    const workspaceDir = `/tmp/${randomUUID()}`;
    const first = makeBootstrapWarn({
      sessionLabel: "agent:main:first-session",
      workspaceDir,
      warn: (message) => warnings.push(message),
    });
    const second = makeBootstrapWarn({
      sessionLabel: "agent:main:second-session",
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    first?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");
    second?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");

    expect(warnings).toEqual([
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:first-session)",
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:second-session)",
    ]);
  });

  it("keeps warnings distinct across workspaces with the same session", () => {
    const warnings: string[] = [];
    const workspaceRoot = `/tmp/${randomUUID()}`;
    const first = makeBootstrapWarn({
      sessionLabel: "agent:main:shared-session",
      workspaceDir: `${workspaceRoot}/workspace-a`,
      warn: (message) => warnings.push(message),
    });
    const second = makeBootstrapWarn({
      sessionLabel: "agent:main:shared-session",
      workspaceDir: `${workspaceRoot}/workspace-b`,
      warn: (message) => warnings.push(message),
    });

    first?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");
    second?.("workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating");

    expect(warnings).toEqual([
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:shared-session)",
      "workspace bootstrap file MEMORY.md is 36697 chars (limit 20000); truncating (sessionKey=agent:main:shared-session)",
    ]);
  });
});

describe("resolveContextInjectionMode", () => {
  it("defaults to always when config is missing", () => {
    expect(resolveContextInjectionMode(undefined)).toBe("always");
  });

  it("defaults to always when the setting is omitted", () => {
    expect(resolveContextInjectionMode({ agents: { defaults: {} } } as never)).toBe("always");
  });

  it("returns the configured continuation-skip mode", () => {
    expect(
      resolveContextInjectionMode({
        agents: { defaults: { contextInjection: "continuation-skip" } },
      } as never),
    ).toBe("continuation-skip");
  });

  it("uses per-agent contextInjection before defaults", () => {
    expect(
      resolveContextInjectionMode(
        {
          agents: {
            defaults: { contextInjection: "continuation-skip" },
            list: [{ id: "strict", contextInjection: "always" }],
          },
        } as never,
        "strict",
      ),
    ).toBe("always");
  });

  it("falls back to defaults when the agent has no contextInjection override", () => {
    expect(
      resolveContextInjectionMode(
        {
          agents: {
            defaults: { contextInjection: "never" },
            list: [{ id: "worker" }],
          },
        } as never,
        "worker",
      ),
    ).toBe("never");
  });
});
