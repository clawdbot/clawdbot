import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerPiSessionCatalog } from "./pi-session-catalog-plugin.js";
import {
  bindTestCatalogOwner,
  type TestSessionCatalogProvider,
} from "./pi-session-catalog.test-support.js";

const PI_SESSIONS_LIST_COMMAND = "acpx.pi.sessions.list.v1";
const PI_SESSION_READ_COMMAND = "acpx.pi.sessions.read.v1";

describe("Pi paired-node session catalog", () => {
  it("bridges list and read requests without undefined transport fields", async () => {
    let provider: TestSessionCatalogProvider | undefined;
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        payloadJSON: JSON.stringify({
          sessions: [
            {
              threadId: "pi-remote",
              status: "stored",
              source: "pi-cli",
              archived: false,
              canContinue: false,
              canArchive: false,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        payloadJSON: JSON.stringify({
          threadId: "pi-remote",
          items: [{ type: "agentMessage", text: "remote answer" }],
        }),
      });
    const api = {
      pluginConfig: {},
      runtime: {
        nodes: {
          list: vi.fn().mockResolvedValue({
            nodes: [
              {
                nodeId: "node-1",
                displayName: "Remote",
                connected: true,
                commands: [PI_SESSIONS_LIST_COMMAND, PI_SESSION_READ_COMMAND],
              },
            ],
          }),
          invoke,
        },
      },
      registerSessionCatalog: (
        value: Parameters<OpenClawPluginApi["registerSessionCatalog"]>[0],
      ) => {
        provider = bindTestCatalogOwner(value);
      },
      registerNodeHostCommand: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    } as unknown as OpenClawPluginApi;

    registerPiSessionCatalog(api);
    const catalog = provider;
    expect(catalog).toBeDefined();
    await catalog!.list({ hostIds: ["node:node-1"] });
    await catalog!.read({ hostId: "node:node-1", threadId: "pi-remote" });

    expect(invoke).toHaveBeenNthCalledWith(1, {
      nodeId: "node-1",
      command: PI_SESSIONS_LIST_COMMAND,
      params: {},
      timeoutMs: 20_000,
      scopes: ["operator.write"],
    });
    expect(invoke).toHaveBeenNthCalledWith(2, {
      nodeId: "node-1",
      command: PI_SESSION_READ_COMMAND,
      params: { threadId: "pi-remote" },
      timeoutMs: 20_000,
      scopes: ["operator.write"],
    });

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: 123,
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          },
        ],
      }),
    });
    await expect(catalog!.list({ hostIds: ["node:node-1"] })).resolves.toEqual([
      expect.objectContaining({
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
    ]);

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: "--help",
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          },
        ],
      }),
    });
    await expect(catalog!.list({ hostIds: ["node:node-1"] })).resolves.toEqual([
      expect.objectContaining({
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
    ]);

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        threadId: "pi-remote",
        items: [{ type: "invalid", text: "bad" }],
      }),
    });
    await expect(catalog!.read({ hostId: "node:node-1", threadId: "pi-remote" })).rejects.toThrow(
      "invalid transcript page",
    );

    invoke.mockClear();
    await expect(
      catalog!.read({ hostId: "node:node-1", threadId: "pi-remote", cursor: "" }),
    ).rejects.toThrow("cursor is invalid");
    await expect(
      catalog!.list({
        hostIds: ["node:node-1"],
        cursors: { "node:node-1": "" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
    ]);
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({ sessions: [], nextCursor: " wrapped " }),
    });
    await expect(catalog!.list({ hostIds: ["node:node-1"] })).resolves.toEqual([
      expect.objectContaining({
        error: { code: "NODE_INVOKE_FAILED", message: expect.any(String) },
      }),
    ]);
    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({
        threadId: "pi-remote",
        items: [],
        nextCursor: " wrapped ",
      }),
    });
    await expect(catalog!.read({ hostId: "node:node-1", threadId: "pi-remote" })).rejects.toThrow(
      "invalid cursor",
    );

    const exactCursor = Buffer.from(JSON.stringify({ offset: 1 }), "utf8").toString("base64url");
    invoke.mockResolvedValueOnce({ payloadJSON: JSON.stringify({ sessions: [] }) });
    await catalog!.list({
      hostIds: ["node:node-1"],
      cursors: { "node:node-1": exactCursor },
    });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { cursor: exactCursor } }),
    );
    invoke.mockResolvedValueOnce({
      payloadJSON: JSON.stringify({ threadId: "pi-remote", items: [] }),
    });
    await catalog!.read({
      hostId: "node:node-1",
      threadId: "pi-remote",
      cursor: exactCursor,
    });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { threadId: "pi-remote", cursor: exactCursor } }),
    );
  });
});
