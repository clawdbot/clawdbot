import fs from "node:fs/promises";
import path from "node:path";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { CODEX_INTERACTIVE_THREAD_SOURCE_KINDS } from "./app-server/protocol.js";
import {
  buildCodexSupervisionTestConnectionFingerprint,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  type CodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createCodexThreadsTool } from "./native-thread-tool.js";

describe("native Codex thread tool", () => {
  let root: string;
  let sessionFile: string;

  async function withFixture(run: () => void | Promise<void>): Promise<void> {
    await withTempDir("openclaw-codex-threads-", async (tempRoot) => {
      root = tempRoot;
      sessionFile = path.join(root, "sessions", "session-id.jsonl");
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      await fs.writeFile(sessionFile, "");
      resetCodexTestBindingStore();
      registerCodexTestSessionIdentity(
        "session-id",
        "session-id",
        "agent:main:telegram:direct:owner",
      );
      await run();
    });
  }

  function createTool(params?: {
    owner?: boolean;
    homeScope?: "agent" | "user";
    omitHomeScope?: boolean;
    supervision?: boolean;
    allowRawTranscripts?: boolean;
    allowWriteControls?: boolean;
    getPluginConfig?: () => unknown;
    request?: ReturnType<typeof vi.fn>;
    sessionId?: string | null;
    modelSelectionLocked?: boolean;
    bindingStore?: CodexAppServerBindingStore;
  }) {
    const context: OpenClawPluginToolContext = {
      config: {},
      agentId: "main",
      agentDir: path.join(root, "agent"),
      workspaceDir: path.join(root, "workspace"),
      sessionKey: "agent:main:telegram:direct:owner",
      sessionId: params?.sessionId === null ? undefined : (params?.sessionId ?? "session-id"),
      senderIsOwner: params?.owner ?? true,
    };
    const runtime = createPluginRuntimeMock({
      agent: {
        session: {
          getSessionEntry: () => ({
            sessionId: "session-id",
            sessionFile,
            updatedAt: Date.now(),
            modelSelectionLocked: params?.modelSelectionLocked,
          }),
          resolveStorePath: () => path.join(root, "sessions", "sessions.json"),
          resolveSessionFilePath: () => sessionFile,
        },
      },
    });
    return createCodexThreadsTool({
      bindingStore: params?.bindingStore ?? testCodexAppServerBindingStore,
      context,
      runtime,
      getPluginConfig:
        params?.getPluginConfig ??
        (() => ({
          ...(params?.omitHomeScope
            ? {}
            : { appServer: { homeScope: params?.homeScope ?? "user" } }),
          ...(params?.supervision
            ? {
                supervision: {
                  enabled: true,
                  ...(params.allowRawTranscripts ? { allowRawTranscripts: true } : {}),
                  ...(params.allowWriteControls ? { allowWriteControls: true } : {}),
                },
              }
            : {}),
        })),
      request: params?.request as never,
    });
  }

  it("materializes only for owner turns with user-home or supervision access", () =>
    withFixture(() => {
      expect(createTool()).not.toBeNull();
      expect(createTool({ owner: false })).toBeNull();
      expect(createTool({ homeScope: "agent" })).toBeNull();
      expect(createTool({ omitHomeScope: true, supervision: true })).not.toBeNull();
    }));

  it("routes a private supervised binding through the supervision connection with native auth", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "supervised-thread",
        connectionScope: "supervision",
        supervisionSourceThreadId: "source-thread",
        appServerRuntimeFingerprint: buildCodexSupervisionTestConnectionFingerprint(),
        cwd: "/tmp/project",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        historyCoveredThrough: new Date().toISOString(),
      });
      const request = vi.fn(async () => ({ data: [] }));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        request,
        modelSelectionLocked: true,
      });

      await tool?.execute("call-supervised-list", { action: "list" });

      expect(request).toHaveBeenCalledWith(
        { supervision: { enabled: true } },
        CODEX_CONTROL_METHODS.listThreads,
        expect.any(Object),
        expect.objectContaining({
          authProfileId: null,
          startOptions: expect.objectContaining({ homeScope: "user" }),
        }),
      );
    }));

  it("lists native threads with bounded deterministic parameters", () =>
    withFixture(async () => {
      const response = { data: [{ id: "thread-1", status: { type: "idle" } }] };
      const request = vi.fn(async () => response);
      const tool = createTool({ request, modelSelectionLocked: true });

      const result = await tool?.execute("call-1", {
        action: "list",
        archived: true,
        cursor: "next-page",
        limit: 12,
        search: "coexistence",
      });

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.listThreads,
        {
          archived: true,
          cursor: "next-page",
          limit: 12,
          modelProviders: [],
          searchTerm: "coexistence",
          sortKey: "recency_at",
          sortDirection: "desc",
          sourceKinds: [...CODEX_INTERACTIVE_THREAD_SOURCE_KINDS],
        },
        expect.objectContaining({
          sessionId: "session-id",
          sessionKey: "agent:main:telegram:direct:owner",
        }),
      );
      expect(result?.details).toEqual(response);
    }));

  it("keeps supervised metadata reads available without leaking transcript fields", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) =>
        method === CODEX_CONTROL_METHODS.listThreads
          ? {
              data: [
                {
                  id: "thread-1",
                  name: "Safe title",
                  preview: "private preview",
                  status: { type: "idle" },
                  turns: [{ id: "turn-1", items: [] }],
                },
              ],
            }
          : {
              thread: {
                id: "thread-1",
                name: "Safe title",
                preview: "private preview",
                status: { type: "idle" },
                turns: [{ id: "turn-1", items: [] }],
              },
            },
      );
      const tool = createTool({ omitHomeScope: true, supervision: true, request });

      const listed = await tool?.execute("call-safe-list", { action: "list" });
      const read = await tool?.execute("call-safe-read", {
        action: "read",
        thread_id: "thread-1",
        include_turns: false,
      });

      expect(listed?.details).toEqual({
        data: [{ id: "thread-1", name: "Safe title", status: { type: "idle" } }],
      });
      expect(read?.details).toEqual({
        thread: { id: "thread-1", name: "Safe title", status: { type: "idle" } },
      });
      expect(request).toHaveBeenCalledTimes(2);
    }));

  it("requires explicit supervision permission for raw transcript reads", () =>
    withFixture(async () => {
      const request = vi.fn();
      const tool = createTool({ omitHomeScope: true, supervision: true, request });

      await expect(
        tool?.execute("call-blocked-read", {
          action: "read",
          thread_id: "thread-1",
          include_turns: true,
        }),
      ).rejects.toThrow("Codex raw transcript reads are disabled");
      expect(request).not.toHaveBeenCalled();
    }));

  it("does not expose transcript search matches when raw transcript access is disabled", () =>
    withFixture(async () => {
      const request = vi.fn();
      const tool = createTool({ omitHomeScope: true, supervision: true, request });

      await expect(
        tool?.execute("call-blocked-search", {
          action: "list",
          search: "private transcript phrase",
        }),
      ).rejects.toThrow("search is disabled while raw transcript access is disabled");
      expect(request).not.toHaveBeenCalled();
    }));

  it("preserves supervised transcript fields when raw reads are explicitly enabled", () =>
    withFixture(async () => {
      const response = {
        thread: {
          id: "thread-1",
          preview: "allowed preview",
          turns: [{ id: "turn-1", items: [] }],
        },
      };
      const request = vi.fn(async () => response);
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowRawTranscripts: true,
        request,
      });

      const result = await tool?.execute("call-allowed-read", {
        action: "read",
        thread_id: "thread-1",
        include_turns: true,
      });

      expect(result?.details).toEqual(response);
    }));

  it.each([
    {
      action: "fork",
      params: { action: "fork", thread_id: "thread-1", attach: false },
    },
    {
      action: "rename",
      params: { action: "rename", thread_id: "thread-1", name: "Renamed" },
    },
    {
      action: "archive",
      params: { action: "archive", thread_id: "thread-1", confirm: true },
    },
    {
      action: "unarchive",
      params: { action: "unarchive", thread_id: "thread-1" },
    },
  ])("blocks supervised $action without write-control permission", ({ params }) =>
    withFixture(async () => {
      const request = vi.fn();
      const tool = createTool({ omitHomeScope: true, supervision: true, request });

      await expect(tool?.execute("call-blocked-write", params)).rejects.toThrow(
        "Codex native thread mutations are disabled",
      );
      expect(request).not.toHaveBeenCalled();
    }),
  );

  it("allows supervised native mutations when write controls are explicitly enabled", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) =>
        method === CODEX_CONTROL_METHODS.readThread
          ? { thread: { id: "other-thread", status: { type: "idle" } } }
          : {},
      );
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      await tool?.execute("call-allowed-write", {
        action: "rename",
        thread_id: "thread-1",
        name: "Renamed",
      });

      expect(request).toHaveBeenCalledWith(
        expect.any(Object),
        CODEX_CONTROL_METHODS.renameThread,
        { threadId: "thread-1", name: "Renamed" },
        expect.any(Object),
      );
    }));

  it("redacts detached fork transcripts when raw reads are disabled", () =>
    withFixture(async () => {
      const request = vi.fn(async () => ({
        thread: {
          id: "forked-thread",
          cwd: "/tmp/project",
          name: "Safe title",
          preview: "private preview",
          status: { type: "idle" },
          turns: [{ id: "turn-1", items: [] }],
        },
      }));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      const result = await tool?.execute("call-redacted-fork", {
        action: "fork",
        thread_id: "source-thread",
        attach: false,
      });

      expect(request).toHaveBeenCalledWith(
        expect.any(Object),
        CODEX_CONTROL_METHODS.forkThread,
        { threadId: "source-thread", threadSource: "user", excludeTurns: true },
        expect.any(Object),
      );
      expect(result?.details).toEqual({
        action: "fork",
        sourceThreadId: "source-thread",
        thread: {
          id: "forked-thread",
          cwd: "/tmp/project",
          name: "Safe title",
          status: { type: "idle" },
        },
        attached: false,
      });
    }));

  it("redacts unarchive transcripts when raw reads are disabled", () =>
    withFixture(async () => {
      const request = vi.fn(async () => ({
        thread: {
          id: "thread-1",
          name: "Safe title",
          preview: "private preview",
          status: { type: "notLoaded" },
          turns: [{ id: "turn-1", items: [] }],
        },
      }));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      const result = await tool?.execute("call-redacted-unarchive", {
        action: "unarchive",
        thread_id: "thread-1",
      });

      expect(request).toHaveBeenCalledWith(
        expect.any(Object),
        CODEX_CONTROL_METHODS.unarchiveThread,
        { threadId: "thread-1" },
        expect.any(Object),
      );
      expect(result?.details).toEqual({
        thread: {
          id: "thread-1",
          name: "Safe title",
          status: { type: "notLoaded" },
        },
      });
    }));

  it("forks a native thread and attaches the fork to the OpenClaw session", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) =>
        method === CODEX_CONTROL_METHODS.readThread
          ? { thread: { id: "source-thread", status: { type: "notLoaded" } } }
          : {
              thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
              model: "gpt-5.5",
              modelProvider: "openai",
            },
      );
      const tool = createTool({ request, sessionId: null });

      const result = await tool?.execute("call-2", {
        action: "fork",
        thread_id: "source-thread",
      });

      expect(request).toHaveBeenNthCalledWith(
        1,
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.readThread,
        { threadId: "source-thread", includeTurns: false },
        expect.any(Object),
      );
      expect(request).toHaveBeenNthCalledWith(
        2,
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.forkThread,
        { threadId: "source-thread", threadSource: "user", excludeTurns: true },
        expect.any(Object),
      );
      await expect(
        readCodexAppServerBinding("session-id", { agentDir: path.join(root, "agent") }),
      ).resolves.toMatchObject({
        threadId: "forked-thread",
        cwd: "/tmp/project",
        model: "gpt-5.5",
        modelProvider: "openai",
        historyCoveredThrough: expect.any(String),
      });
      expect(result?.details).toMatchObject({
        action: "fork",
        sourceThreadId: "source-thread",
        attached: true,
      });
    }));

  it.each([
    {
      name: "a different thread id",
      response: { thread: { id: "different-thread", status: { type: "idle" } } },
      error: "returned a different thread than requested",
    },
    {
      name: "a malformed response",
      response: { thread: null },
      error: "returned an invalid thread/read response",
    },
    {
      name: "an unknown status",
      response: { thread: { id: "source-thread", status: { type: "futureStatus" } } },
      error: "unless it is idle or not loaded",
    },
    {
      name: "a missing status",
      response: { thread: { id: "source-thread" } },
      error: "unless it is idle or not loaded",
    },
    {
      name: "a system-error status",
      response: { thread: { id: "source-thread", status: { type: "systemError" } } },
      error: "unless it is idle or not loaded",
    },
    {
      name: "an active status",
      response: { thread: { id: "source-thread", status: { type: "active" } } },
      error: "unless it is idle or not loaded",
    },
  ])("refuses to attach a fork of the bound thread after $name", ({ response, error }) =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "source-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => response);
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-unsafe-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow(error);
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.readThread,
        { threadId: "source-thread", includeTurns: false },
        expect.anything(),
      );
      expect(request).not.toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.forkThread,
        expect.anything(),
        expect.anything(),
      );
    }),
  );

  it("reports a conflict when a fork cannot attach to the current generation", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) =>
        method === CODEX_CONTROL_METHODS.readThread
          ? { thread: { id: "source-thread", status: { type: "idle" } } }
          : { thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } } },
      );
      const mutate = vi
        .spyOn(testCodexAppServerBindingStore, "mutate")
        .mockResolvedValueOnce(false);
      try {
        await expect(
          createTool({ request })?.execute("call-conflict", {
            action: "fork",
            thread_id: "source-thread",
          }),
        ).rejects.toThrow("binding changed before the fork could be attached");
      } finally {
        mutate.mockRestore();
      }
    }));

  it("does not replace a locked session binding with an attached fork", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => ({
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      }));
      const tool = createTool({ request, modelSelectionLocked: true });

      await expect(
        tool?.execute("call-locked-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);

      expect(request).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "bound-thread",
      });
    }));

  it("keeps an attached fork off a private supervision connection", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        connectionScope: "supervision",
        supervisionSourceThreadId: "source-thread",
        cwd: "/tmp/project",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        historyCoveredThrough: new Date().toISOString(),
      });
      const request = vi.fn(async () => ({
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      }));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      await expect(
        tool?.execute("call-supervised-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("Supervised Codex forks must stay detached");

      expect(request).not.toHaveBeenCalled();
    }));

  it("keeps an attached fork off a supervision-only connection without a binding", () =>
    withFixture(async () => {
      const request = vi.fn();
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      await expect(
        tool?.execute("call-supervision-only-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("Supervised Codex forks must stay detached");
      expect(request).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding("session-id")).resolves.toBeUndefined();
    }));

  it("rechecks the live connection config before attaching a fork", () =>
    withFixture(async () => {
      let pluginConfig: unknown = { appServer: { homeScope: "user" } };
      const request = vi.fn();
      const tool = createTool({ request, getPluginConfig: () => pluginConfig });
      pluginConfig = { supervision: { enabled: true, allowWriteControls: true } };

      await expect(
        tool?.execute("call-live-supervision-fork", {
          action: "fork",
          thread_id: "source-thread",
        }),
      ).rejects.toThrow("Supervised Codex forks must stay detached");
      expect(request).not.toHaveBeenCalled();
    }));

  it("allows a detached fork through a supervision-only connection", () =>
    withFixture(async () => {
      const response = {
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      };
      const request = vi.fn(async () => response);
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      const result = await tool?.execute("call-supervision-detached-fork", {
        action: "fork",
        thread_id: "source-thread",
        attach: false,
      });

      expect(result?.details).toMatchObject({ attached: false });
      await expect(readCodexAppServerBinding("session-id")).resolves.toBeUndefined();
    }));

  it("allows a detached fork without changing a locked session binding", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => ({
        thread: { id: "forked-thread", cwd: "/tmp/project", status: { type: "idle" } },
      }));
      const tool = createTool({ request, modelSelectionLocked: true });

      const result = await tool?.execute("call-detached-fork", {
        action: "fork",
        thread_id: "source-thread",
        attach: false,
      });

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.forkThread,
        { threadId: "source-thread", threadSource: "user", excludeTurns: true },
        expect.any(Object),
      );
      expect(result?.details).toMatchObject({ attached: false });
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "bound-thread",
      });
    }));

  it("refuses to archive an active bound thread", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "active-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async (_config, method: string) => {
        if (method === CODEX_CONTROL_METHODS.readThread) {
          return { thread: { id: "active-thread", status: { type: "active" } } };
        }
        return {};
      });
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-3", {
          action: "archive",
          thread_id: "active-thread",
          confirm: true,
        }),
      ).rejects.toThrow("cannot archive an active Codex thread");
      expect(request).not.toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.archiveThread,
        expect.anything(),
        expect.anything(),
      );
    }));

  it("archives an idle bound thread and clears its attachment", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "idle-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async (_config, method: string) => {
        if (method === CODEX_CONTROL_METHODS.readThread) {
          return { thread: { id: "idle-thread", status: { type: "idle" } } };
        }
        if (method === CODEX_CONTROL_METHODS.listThreads) {
          return { data: [] };
        }
        return {};
      });
      const tool = createTool({ request });

      await tool?.execute("call-4", {
        action: "archive",
        thread_id: "idle-thread",
        confirm: true,
      });

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.readThread,
        { threadId: "idle-thread", includeTurns: false },
        expect.any(Object),
      );
      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        CODEX_CONTROL_METHODS.archiveThread,
        { threadId: "idle-thread" },
        expect.any(Object),
      );
      await expect(readCodexAppServerBinding("session-id")).resolves.toBeUndefined();
    }));

  it.each([
    {
      name: "a mismatched read response",
      response: { thread: { id: "different-thread", status: { type: "idle" } } },
      error: "returned a different thread than requested",
    },
    {
      name: "a missing status",
      response: { thread: { id: "thread-1" } },
      error: "cannot verify that the Codex thread is idle",
    },
    {
      name: "a system-error status",
      response: { thread: { id: "thread-1", status: { type: "systemError" } } },
      error: "cannot verify that the Codex thread is idle",
    },
  ])("refuses to archive after $name", ({ response, error }) =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "thread-1",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => response);
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-unsafe-archive", {
          action: "archive",
          thread_id: "thread-1",
          confirm: true,
        }),
      ).rejects.toThrow(error);
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.readThread,
        { threadId: "thread-1", includeTurns: false },
        expect.anything(),
      );
    }),
  );

  it("does not archive and clear the thread bound to a locked session", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async () => ({}));
      const tool = createTool({ request, modelSelectionLocked: true });

      await expect(
        tool?.execute("call-locked-archive", {
          action: "archive",
          thread_id: "bound-thread",
          confirm: true,
        }),
      ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);

      expect(request).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "bound-thread",
      });
    }));

  it("rechecks a binding attached while archive waits for its ownership fence", () =>
    withFixture(async () => {
      let fenced = false;
      const bindingStore: CodexAppServerBindingStore = {
        ...testCodexAppServerBindingStore,
        withThreadArchiveFence: async (run) => {
          if (!fenced) {
            fenced = true;
            await writeCodexAppServerBinding("session-id", {
              threadId: "newly-bound-thread",
              cwd: "/tmp/project",
            });
          }
          return await testCodexAppServerBindingStore.withThreadArchiveFence(run);
        },
      };
      const request = vi.fn(async () => ({}));
      const tool = createTool({ bindingStore, request, modelSelectionLocked: true });

      await expect(
        tool?.execute("call-raced-locked-archive", {
          action: "archive",
          thread_id: "newly-bound-thread",
          confirm: true,
        }),
      ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);

      expect(request).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "newly-bound-thread",
      });
    }));

  it("does not archive a private supervised binding even if the public lock is unavailable", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        connectionScope: "supervision",
        supervisionSourceThreadId: "source-thread",
        cwd: "/tmp/project",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        historyCoveredThrough: new Date().toISOString(),
      });
      const request = vi.fn(async () => ({}));
      const tool = createTool({
        omitHomeScope: true,
        supervision: true,
        allowWriteControls: true,
        request,
      });

      await expect(
        tool?.execute("call-supervised-archive", {
          action: "archive",
          thread_id: "bound-thread",
          confirm: true,
        }),
      ).rejects.toThrow("Refusing to replace supervised Codex thread");

      expect(request).not.toHaveBeenCalled();
    }));

  it("allows a locked session to archive an unowned unrelated thread", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "bound-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async (_config, method: string) =>
        method === CODEX_CONTROL_METHODS.readThread
          ? { thread: { id: "other-thread", status: { type: "idle" } } }
          : method === CODEX_CONTROL_METHODS.listThreads
            ? { data: [] }
            : {},
      );
      const tool = createTool({
        request,
        modelSelectionLocked: true,
        supervision: true,
        allowWriteControls: true,
      });

      await tool?.execute("call-other-archive", {
        action: "archive",
        thread_id: "other-thread",
        confirm: true,
      });

      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.archiveThread,
        { threadId: "other-thread" },
        expect.anything(),
      );
      await expect(readCodexAppServerBinding("session-id")).resolves.toMatchObject({
        threadId: "bound-thread",
      });
    }));

  it("rejects archive when another OpenClaw session owns the thread", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "current-thread",
        cwd: "/tmp/project",
      });
      await writeCodexAppServerBinding("other-session", {
        threadId: "other-thread",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async (_config, method: string) =>
        method === CODEX_CONTROL_METHODS.readThread
          ? { thread: { id: "other-thread", status: { type: "idle" } } }
          : {},
      );
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-owned-archive", {
          action: "archive",
          thread_id: "other-thread",
          confirm: true,
        }),
      ).rejects.toThrow("owned by another OpenClaw session");

      expect(request).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.archiveThread,
        expect.anything(),
        expect.anything(),
      );
      await expect(readCodexAppServerBinding("other-session")).resolves.toMatchObject({
        threadId: "other-thread",
      });
    }));

  it("rejects archive when a spawned descendant is owned by an OpenClaw session", () =>
    withFixture(async () => {
      await writeCodexAppServerBinding("session-id", {
        threadId: "current-thread",
        cwd: "/tmp/project",
      });
      await writeCodexAppServerBinding("other-session", {
        threadId: "owned-descendant",
        cwd: "/tmp/project",
      });
      const request = vi.fn(async (_config, method: string, requestParams?: unknown) => {
        if (method === CODEX_CONTROL_METHODS.readThread) {
          return {
            thread: {
              id: (requestParams as { threadId: string }).threadId,
              status: { type: "idle" },
            },
          };
        }
        if (method === CODEX_CONTROL_METHODS.listThreads) {
          return { data: [{ id: "owned-descendant" }] };
        }
        return {};
      });
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-descendant-owned-archive", {
          action: "archive",
          thread_id: "parent-thread",
          confirm: true,
        }),
      ).rejects.toThrow("spawned descendant is owned by an OpenClaw session");

      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.listThreads,
        {
          ancestorThreadId: "parent-thread",
          archived: false,
          limit: 100,
          sortKey: "created_at",
          sortDirection: "desc",
          useStateDbOnly: true,
        },
        expect.anything(),
      );
      expect(request).not.toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.archiveThread,
        expect.anything(),
        expect.anything(),
      );
    }));

  it("fails closed when native descendant enumeration errors", () =>
    withFixture(async () => {
      const request = vi.fn(async (_config, method: string) => {
        if (method === CODEX_CONTROL_METHODS.readThread) {
          return { thread: { id: "parent-thread", status: { type: "idle" } } };
        }
        if (method === CODEX_CONTROL_METHODS.listThreads) {
          throw new Error("descendant lookup failed");
        }
        return {};
      });
      const tool = createTool({ request });

      await expect(
        tool?.execute("call-descendant-error-archive", {
          action: "archive",
          thread_id: "parent-thread",
          confirm: true,
        }),
      ).rejects.toThrow("descendant lookup failed");
      expect(request).not.toHaveBeenCalledWith(
        expect.anything(),
        CODEX_CONTROL_METHODS.archiveThread,
        expect.anything(),
        expect.anything(),
      );
    }));

  it.each([
    {
      action: "read" as const,
      params: { action: "read", thread_id: "thread-1", include_turns: true },
      method: CODEX_CONTROL_METHODS.readThread,
      requestParams: { threadId: "thread-1", includeTurns: true },
    },
    {
      action: "rename" as const,
      params: { action: "rename", thread_id: "thread-1", name: "Shared thread" },
      method: CODEX_CONTROL_METHODS.renameThread,
      requestParams: { threadId: "thread-1", name: "Shared thread" },
    },
    {
      action: "unarchive" as const,
      params: { action: "unarchive", thread_id: "thread-1" },
      method: CODEX_CONTROL_METHODS.unarchiveThread,
      requestParams: { threadId: "thread-1" },
    },
  ])("routes $action through the typed Codex control method", ({ params, method, requestParams }) =>
    withFixture(async () => {
      const request = vi.fn(async () => ({ thread: { id: "thread-1" } }));
      const tool = createTool({ request, modelSelectionLocked: true });

      await tool?.execute("call-5", params);

      expect(request).toHaveBeenCalledWith(
        { appServer: { homeScope: "user" } },
        method,
        requestParams,
        expect.any(Object),
      );
    }),
  );
});
