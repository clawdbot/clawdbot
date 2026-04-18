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
    From: "imessage:work:demo",
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
        if (dirName === "imessage" && artifactBasename === "media-contract-api.js") {
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
        ctx: createContext("imessage"),
      }),
    ).toEqual(["/local/work"]);
    expect(
      resolveChannelRemoteInboundAttachmentRoots({
        cfg,
        ctx: createContext("imessage"),
      }),
    ).toEqual(["/remote/work"]);
    expect(publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith(
      {
        dirName: "imessage",
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
        ctx: createContext("whatsapp"),
      }),
    ).toBeUndefined();
    expect(publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync).toHaveBeenCalledWith(
      {
        dirName: "whatsapp",
        artifactBasename: "media-contract-api.js",
      },
    );
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync,
    ).not.toHaveBeenCalledWith({
      dirName: "whatsapp",
      artifactBasename: "contract-api.js",
    });
    expect(
      publicSurfaceLoaderMocks.loadBundledPluginPublicArtifactModuleSync,
    ).not.toHaveBeenCalledWith({
      dirName: "whatsapp",
      artifactBasename: "index.js",
    });
  });
});
