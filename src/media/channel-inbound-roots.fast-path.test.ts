import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";

const publicSurfaceLoaderMocks = vi.hoisted(() => ({
  loadBundledPluginPublicArtifactModuleSync: vi.fn(),
}));

vi.mock("../plugins/public-surface-loader.js", () => publicSurfaceLoaderMocks);

import {
  resolveChannelInboundAttachmentRoots,
  resolveChannelRemoteInboundAttachmentRoots,
} from "./channel-inbound-roots.js";

const cfg = {
  channels: {},
} as OpenClawConfig;

function unableToResolve(dirName: string, artifactBasename: string): Error {
  return new Error(
    `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
  );
}

function createContext(provider: string, accountId = "work"): MsgContext {
  return {
    Body: "hi",
    From: "localchat:work:demo",
    To: "+2000",
    ChatType: "direct",
    Provider: provider,
    AccountId: accountId,
  };
}

beforeEach(() => {
  publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync.mockReset();
});

describe("channel inbound roots fast path", () => {
  it("prefers media contract artifacts over full channel bootstrap", () => {
    publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync.mockImplementation(
      ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
        if (dirName === "localchat" && artifactBasename === "media-contract-api.js") {
          return {
            resolveInboundAttachmentRoots: ({ accountId }: { accountId?: string }) => [
              `/local/${accountId}`,
            ],
            resolveRemoteInboundAttachmentRoots: ({ accountId }: { accountId?: string }) => [
              `/remote/${accountId}`,
            ],
          };
        }
        throw unableToResolve(dirName, artifactBasename);
      },
    );

    expect(
      resolveChannelInboundAttachmentRoots({
        cfg,
        ctx: createContext("localchat"),
      }),
    ).toEqual(["/local/work"]);
    expect(
      resolveChannelRemoteInboundAttachmentRoots({
        cfg,
        ctx: createContext("localchat"),
      }),
    ).toEqual(["/remote/work"]);
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync,
    ).toHaveBeenCalledOnce();
    expect(publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith(
      {
        dirName: "localchat",
        artifactBasename: "media-contract-api.js",
      },
    );
  });

  it("does not load broad generic contract artifacts on the media-root path", () => {
    publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync.mockImplementation(
      ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
        throw unableToResolve(dirName, artifactBasename);
      },
    );

    expect(
      resolveChannelRemoteInboundAttachmentRoots({
        cfg,
        ctx: createContext("mobilechat"),
      }),
    ).toBeUndefined();
    expect(publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith(
      {
        dirName: "mobilechat",
        artifactBasename: "media-contract-api.js",
      },
    );
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync,
    ).not.toHaveBeenCalledWith({
      dirName: "mobilechat",
      artifactBasename: "contract-api.js",
    });
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync,
    ).not.toHaveBeenCalledWith({
      dirName: "mobilechat",
      artifactBasename: "index.js",
    });
  });

  it("preserves partial media contract modules when a missing resolver is checked first", () => {
    publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync.mockImplementation(
      ({ artifactBasename, dirName }: { artifactBasename: string; dirName: string }) => {
        if (dirName === "partialchat" && artifactBasename === "media-contract-api.js") {
          return {
            resolveInboundAttachmentRoots: ({ accountId }: { accountId?: string }) => [
              `/partial/${accountId}`,
            ],
          };
        }
        throw unableToResolve(dirName, artifactBasename);
      },
    );

    expect(
      resolveChannelRemoteInboundAttachmentRoots({
        cfg,
        ctx: createContext("partialchat"),
      }),
    ).toBeUndefined();
    expect(
      resolveChannelInboundAttachmentRoots({
        cfg,
        ctx: createContext("partialchat"),
      }),
    ).toEqual(["/partial/work"]);
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync,
    ).toHaveBeenCalledOnce();
  });
});
