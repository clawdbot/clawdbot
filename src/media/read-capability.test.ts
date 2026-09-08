// Media read capability tests cover allowed roots and blocked file access.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    {
      name: "sender wildcard without identity",
      cfg: {
        tools: {
          allow: ["read"],
          toolsBySender: { "*": { deny: ["read"] } },
        },
      } as OpenClawConfig,
      identity: { messageProvider: "requestchat" },
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
    const baseDir = tempDirs.make("openclaw-media-sender-policy-");
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

    const workspaceReadFile = vi.fn(async () => Buffer.from("private"));
    const deniedAccess = resolveAgentScopedOutboundMediaAccess({
      cfg,
      agentId: "restricted",
      messageProvider: "requestchat",
      requesterSenderId: "attacker",
      mediaSources: [workspaceFile],
      workspaceMediaAccess: {
        localRoots: [workspaceDir],
        readFile: workspaceReadFile,
        workspaceDir,
      },
    });
    await expect(
      loadWebMediaRaw(workspaceFile, buildOutboundMediaLoadOptions({ mediaAccess: deniedAccess })),
    ).rejects.toThrow(/not under an allowed directory/i);
    expect(workspaceReadFile).not.toHaveBeenCalled();

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
  });

  it("keeps approved temp media readable with a workspace reader in workspace-only mode", async () => {
    const preferredTmpRoot = getDefaultMediaLocalRoots()[0];
    if (!preferredTmpRoot) {
      throw new Error("preferred temp media root is unavailable");
    }
    await fs.mkdir(preferredTmpRoot, { recursive: true });
    const tempMediaDir = tempDirs.make("workspace-only-media-", preferredTmpRoot);
    const workspaceDir = tempDirs.make("workspace-only-agent-");
    const tempMediaPath = path.join(tempMediaDir, "generated.txt");
    await fs.writeFile(tempMediaPath, "generated");
    const workspaceReadFile = vi.fn(async () => Buffer.from("workspace"));
    const access = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        tools: { allow: ["read"], fs: { workspaceOnly: true } },
      } as OpenClawConfig,
      workspaceDir,
      mediaSources: [tempMediaPath],
      workspaceMediaAccess: {
        localRoots: [workspaceDir],
        readFile: workspaceReadFile,
        workspaceDir,
      },
    });

    const loaded = await loadWebMediaRaw(
      tempMediaPath,
      buildOutboundMediaLoadOptions({ mediaAccess: access }),
    );
    expect(loaded.buffer.toString()).toBe("generated");
    expect(workspaceReadFile).not.toHaveBeenCalled();
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
  it("includes configured mediaLocalRoots only when host reads are allowed", () => {
    const extraRoot = process.platform === "win32" ? "C:\\data\\snapshots" : "/data/snapshots";
    const cfg = {
      tools: { allow: ["read"] },
      agents: { defaults: { mediaLocalRoots: [extraRoot] } },
    } as OpenClawConfig;

    const allowed = resolveAgentScopedOutboundMediaAccess({
      cfg,
      messageProvider: "telegram",
      requesterSenderId: "trusted-user",
    });
    expect(allowed.localRoots).toContain(extraRoot);
    expect(allowed.readFile).toBeTypeOf("function");

    const groupCfg = {
      ...cfg,
      channels: {
        telegram: {
          groups: {
            "-100123": {
              toolsBySender: {
                "id:attacker": { deny: ["read"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    // Without inbound sender identity, toolsBySender denials cannot apply.
    const bypassedWithoutSender = resolveAgentScopedOutboundMediaAccess({
      cfg: groupCfg,
      messageProvider: "telegram",
      sessionKey: "agent:main:telegram:group:-100123",
      groupId: "-100123",
    });
    expect(bypassedWithoutSender.localRoots).toContain(extraRoot);

    const denied = resolveAgentScopedOutboundMediaAccess({
      cfg: groupCfg,
      messageProvider: "telegram",
      sessionKey: "agent:main:telegram:group:-100123",
      groupId: "-100123",
      requesterSenderId: "attacker",
    });
    expect(denied.readFile).toBeUndefined();
    expect(denied.localRoots).not.toContain(extraRoot);
  });

  it.each([
    {
      name: "workspaceOnly",
      tools: { allow: ["read"] as const, fs: { workspaceOnly: true } },
    },
    {
      name: "messaging profile",
      tools: { profile: "messaging" as const },
    },
    {
      name: "explicit global read deny",
      tools: { deny: ["read"] as const },
    },
  ])("withholds configured mediaLocalRoots when $name forbids host-root expansion", ({ tools }) => {
    const extraRoot = process.platform === "win32" ? "C:\\data\\snapshots" : "/data/snapshots";
    const result = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        tools,
        agents: { defaults: { mediaLocalRoots: [extraRoot] } },
      } as OpenClawConfig,
      messageProvider: "telegram",
      requesterSenderId: "trusted-user",
    });

    expect(result.localRoots).not.toContain(extraRoot);
    expect(result.readFile).toBeUndefined();
  });

  it("rejects configured-root loads before I/O when workspaceOnly forbids expansion", async () => {
    const extraRoot = tempDirs.make("media-local-roots-forbidden-");
    const secretPath = path.join(extraRoot, "secret.png");
    const access = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        tools: { allow: ["read"], fs: { workspaceOnly: true } },
        agents: { defaults: { mediaLocalRoots: [extraRoot] } },
      } as OpenClawConfig,
      messageProvider: "telegram",
      requesterSenderId: "trusted-user",
    });
    // Telegram reply delivery drops the resolver to bare roots and lets the
    // common loader read from them. Rejection must happen at the root list,
    // not after opening the configured file.
    await expect(
      loadWebMediaRaw(
        secretPath,
        buildOutboundMediaLoadOptions({ mediaLocalRoots: access.localRoots }),
      ),
    ).rejects.toMatchObject({ code: "path-not-allowed" });
  });
});
