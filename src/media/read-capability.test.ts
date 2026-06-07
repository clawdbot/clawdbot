// Media read capability tests cover allowed roots and blocked file access.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { getDefaultMediaLocalRoots } from "./local-roots.js";
import { resolveAgentScopedOutboundMediaAccess } from "./read-capability.js";

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
