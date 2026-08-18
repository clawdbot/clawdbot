// Media read capability tests cover allowed roots and blocked file access.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { readOutboundMediaFile } from "./bounded-read-file.js";
import { buildOutboundMediaLoadOptions } from "./load-options.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";
import { resolveAgentScopedOutboundMediaAccess } from "./read-capability.js";
import { loadWebMediaRaw } from "./web-media.js";

const channelPluginMocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn<
    () =>
      | {
          groups?: {
            resolveToolPolicy?: (params: unknown) => { deny?: string[]; allow?: string[] };
          };
        }
      | undefined
  >(() => undefined),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: channelPluginMocks.getLoadedChannelPlugin,
}));

describe("resolveAgentScopedOutboundMediaAccess", () => {
  afterEach(() => {
    __setFsSafeTestHooksForTest(undefined);
    vi.unstubAllEnvs();
    channelPluginMocks.getLoadedChannelPlugin.mockReset();
  });

  it("preserves caller-provided workspaceDir from mediaAccess", () => {
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {} as OpenClawConfig,
      mediaAccess: { workspaceDir: "/tmp/media-workspace" },
    });

    expect(Object.keys(result)).toStrictEqual(["localRoots", "readFile", "workspaceDir"]);
    expect(result.localRoots).toStrictEqual([
      ...getDefaultMediaLocalRoots(),
      "/tmp/media-workspace",
    ]);
    expect(typeof result.readFile).toBe("function");
    expect(result.workspaceDir).toBe("/tmp/media-workspace");
  });

  it("prefers explicit workspaceDir over mediaAccess.workspaceDir", () => {
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {} as OpenClawConfig,
      workspaceDir: "/tmp/explicit-workspace",
      mediaAccess: { workspaceDir: "/tmp/media-workspace" },
    });

    expect(Object.keys(result)).toStrictEqual(["localRoots", "readFile", "workspaceDir"]);
    expect(result.localRoots).toStrictEqual([
      ...getDefaultMediaLocalRoots(),
      "/tmp/explicit-workspace",
    ]);
    expect(typeof result.readFile).toBe("function");
    expect(result.workspaceDir).toBe("/tmp/explicit-workspace");
  });

  it("keeps explicit workspaceDir in localRoots when agent id is unavailable", () => {
    const workspaceDir = "/tmp/openclaw-home/workspace-xiaoqian";
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        tools: {
          fs: { workspaceOnly: true },
        },
      } as OpenClawConfig,
      workspaceDir,
      mediaSources: [`${workspaceDir}/report.html`],
    });

    expect(result.localRoots).toContain(workspaceDir);
    expect(result.workspaceDir).toBe(workspaceDir);
  });

  it("does not enable host reads when sender group policy denies read", () => {
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read"],
      },
      channels: {
        requestchat: {
          groups: {
            ops: {
              toolsBySender: {
                "id:attacker": {
                  deny: ["read"],
                },
              },
            },
          },
        },
      },
    };

    const result = resolveAgentScopedOutboundMediaAccess({
      cfg,
      sessionKey: "agent:main:requestchat:group:ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
      // Production call sites set messageProvider: undefined when sessionKey is present;
      // resolveGroupToolPolicy derives channel from the session key instead.
      requesterSenderId: "attacker",
    });

    expect(result.readFile).toBeUndefined();
    expect(result.localRoots).not.toContain("/Users/peter/Pictures");
  });

  it.each([
    {
      name: "global sender id",
      cfg: {
        tools: {
          allow: ["read"],
          toolsBySender: { "id:attacker": { deny: ["read"] } },
        },
      } as OpenClawConfig,
      identity: { messageProvider: "requestchat", requesterSenderId: "attacker" },
    },
    {
      name: "agent sender username",
      cfg: {
        tools: { allow: ["read"] },
        agents: {
          list: [
            {
              id: "restricted",
              workspace: "/tmp/restricted-workspace",
              tools: {
                toolsBySender: { "username:blocked-user": { deny: ["read"] } },
              },
            },
          ],
        },
      } as OpenClawConfig,
      identity: {
        agentId: "restricted",
        messageProvider: "requestchat",
        requesterSenderUsername: "blocked-user",
      },
    },
    {
      name: "session-derived channel sender id",
      cfg: {
        tools: {
          allow: ["read"],
          toolsBySender: { "channel:requestchat:attacker": { deny: ["read"] } },
        },
      } as OpenClawConfig,
      identity: {
        sessionKey: "agent:main:requestchat:group:ops",
        requesterSenderId: "attacker",
      },
    },
    {
      name: "sender wildcard",
      cfg: {
        tools: {
          allow: ["read"],
          toolsBySender: { "*": { deny: ["read"] } },
        },
      } as OpenClawConfig,
      identity: { messageProvider: "requestchat", requesterSenderId: "attacker" },
    },
  ])("does not enable host reads for $name policy", ({ cfg, identity }) => {
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg,
      ...identity,
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });

    expect(result.readFile).toBeUndefined();
    expect(result.localRoots).not.toContain("/Users/peter/Pictures");
  });

  it("keeps host reads enabled when agent sender policy allows the requester", () => {
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read"],
        toolsBySender: { "*": { deny: ["read"] } },
      },
      agents: {
        list: [
          {
            id: "trusted",
            workspace: "/tmp/trusted-workspace",
            tools: { toolsBySender: { "id:trusted-user": {} } },
          },
        ],
      },
    };

    const result = resolveAgentScopedOutboundMediaAccess({
      cfg,
      agentId: "trusted",
      messageProvider: "requestchat",
      requesterSenderId: "trusted-user",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });

    expect(result.readFile).toBeTypeOf("function");
    expect(result.localRoots).toContain("/Users/peter/Pictures");
  });

  it("blocks denied workspace attachments while preserving managed artifacts", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-sender-policy-"));
    const stateDir = path.join(baseDir, "state");
    const workspaceDir = path.join(baseDir, "workspace");
    const workspaceFile = path.join(workspaceDir, "private.bin");
    const managedFile = path.join(stateDir, "media", "tool-image-generation", "result.bin");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await fs.mkdir(path.dirname(managedFile), { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(workspaceFile, "private");
    await fs.writeFile(managedFile, "managed");
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read"],
        toolsBySender: { "id:attacker": { deny: ["read"] } },
      },
      agents: { list: [{ id: "restricted", workspace: workspaceDir }] },
    };

    try {
      const deniedAccess = resolveAgentScopedOutboundMediaAccess({
        cfg,
        agentId: "restricted",
        messageProvider: "requestchat",
        requesterSenderId: "attacker",
        mediaSources: [workspaceFile],
      });
      await expect(
        loadWebMediaRaw(
          workspaceFile,
          buildOutboundMediaLoadOptions({ mediaAccess: deniedAccess }),
        ),
      ).rejects.toThrow(/not under an allowed directory/i);

      const managedAccess = resolveAgentScopedOutboundMediaAccess({
        cfg,
        agentId: "restricted",
        messageProvider: "requestchat",
        requesterSenderId: "attacker",
        mediaSources: [managedFile],
      });
      const loaded = await loadWebMediaRaw(
        managedFile,
        buildOutboundMediaLoadOptions({ mediaAccess: managedAccess }),
      );
      expect(loaded.buffer.toString()).toBe("managed");
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });

  it("honors plugin-owned group tool policy with channel metadata", () => {
    const resolveToolPolicy = vi.fn(() => ({ deny: ["read"] }));
    channelPluginMocks.getLoadedChannelPlugin.mockReturnValue({
      groups: { resolveToolPolicy },
    });

    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        tools: {
          allow: ["read"],
        },
      } as OpenClawConfig,
      sessionKey: "agent:main:slack:group:C123",
      groupChannel: "#incidents",
      groupSpace: "team-a",
      accountId: "workspace-1",
      requesterSenderId: "U123",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
    });

    expect(result.readFile).toBeUndefined();
    expect(resolveToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "C123",
        groupChannel: "#incidents",
        groupSpace: "team-a",
        accountId: "workspace-1",
        senderId: "U123",
      }),
    );
  });

  it("keeps host reads enabled when sender group policy allows read", () => {
    const cfg: OpenClawConfig = {
      tools: {
        allow: ["read"],
      },
      channels: {
        requestchat: {
          groups: {
            ops: {
              toolsBySender: {
                "id:trusted-user": {
                  allow: ["read"],
                },
              },
            },
          },
        },
      },
    };

    const result = resolveAgentScopedOutboundMediaAccess({
      cfg,
      sessionKey: "agent:main:requestchat:group:ops",
      mediaSources: ["/Users/peter/Pictures/photo.png"],
      requesterSenderId: "trusted-user",
    });

    expect(result.readFile).toBeTypeOf("function");
    expect(result.localRoots).toContain("/Users/peter/Pictures");
  });

  it("keeps host reads enabled when no group policy applies", () => {
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        tools: {
          allow: ["read"],
        },
      } as OpenClawConfig,
      messageProvider: "requestchat",
      requesterSenderId: "trusted-user",
    });

    expect(result.readFile).toBeTypeOf("function");
  });

  it("enforces the caller byte cap before buffering host media", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-cap-"));
    try {
      const filePath = path.join(workspaceDir, "oversized.bin");
      await fs.writeFile(filePath, Buffer.alloc(2));
      const result = resolveAgentScopedOutboundMediaAccess({
        cfg: {
          tools: {
            allow: ["read"],
          },
        } as OpenClawConfig,
        workspaceDir,
      });

      await expect(
        readOutboundMediaFile(result.readFile!, filePath, { maxBytes: 1 }),
      ).rejects.toThrow(/exceeds.*1 byte/i);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects owned host reads when an allowed ancestor symlink retargets before open",
    async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-media-race-"));
      const workspaceDir = path.join(base, "workspace");
      const insideDir = path.join(workspaceDir, "inside");
      const outsideDir = path.join(base, "outside");
      const aliasDir = path.join(workspaceDir, "slot");
      const filePath = path.join(aliasDir, "report.csv");
      await fs.mkdir(insideDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(insideDir, "report.csv"), "inside");
      await fs.writeFile(path.join(outsideDir, "report.csv"), "outside-secret");
      await fs.symlink(insideDir, aliasDir);
      const result = resolveAgentScopedOutboundMediaAccess({
        cfg: { tools: { allow: ["read"] } } as OpenClawConfig,
        workspaceDir,
        mediaSources: [filePath],
      });
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: async (openedPath) => {
          if (openedPath !== filePath) {
            return;
          }
          await fs.rm(aliasDir);
          await fs.symlink(outsideDir, aliasDir);
        },
      });

      try {
        await expect(
          readOutboundMediaFile(result.readFile!, filePath, { maxBytes: 1024 }),
          // fs-safe 0.5.2 reports pre-open identity drift as path-mismatch.
        ).rejects.toMatchObject({ code: "path-mismatch" });
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    },
  );

  it("keeps host reads enabled for DM sender when no group context exists", () => {
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        tools: {
          allow: ["read"],
        },
        channels: {
          requestchat: {
            groups: {
              ops: {
                toolsBySender: {
                  "id:dm-sender": {
                    deny: ["read"],
                  },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      messageProvider: "requestchat",
      requesterSenderId: "dm-sender",
    });

    expect(result.readFile).toBeTypeOf("function");
  });
});
