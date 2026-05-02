import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

type ChannelMediaContractApi = {
  resolveInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => readonly string[] | undefined;
  resolveRemoteInboundAttachmentRoots?: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
  }) => readonly string[] | undefined;
};
type ChannelMediaRootResolver = keyof ChannelMediaContractApi;

const mediaContractApiByChannel = new Map<string, ChannelMediaContractApi | null>();

function loadChannelMediaContractApi(
  channelId: string,
  resolver: ChannelMediaRootResolver,
): ChannelMediaContractApi | undefined {
  if (mediaContractApiByChannel.has(channelId)) {
    const cached = mediaContractApiByChannel.get(channelId);
    return cached && typeof cached[resolver] === "function" ? cached : undefined;
  }

  try {
    const loaded = loadBundledPluginPublicArtifactModuleSync<ChannelMediaContractApi>({
      dirName: channelId,
      artifactBasename: "media-contract-api.js",
    });
    mediaContractApiByChannel.set(channelId, loaded);
    if (typeof loaded[resolver] === "function") {
      return loaded;
    }
    return undefined;
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      )
    ) {
      throw error;
    }
  }

  mediaContractApiByChannel.set(channelId, null);
  return undefined;
}

function findChannelMediaContractApi(
  channelId: string | null | undefined,
  resolver: ChannelMediaRootResolver,
) {
  const normalized = normalizeOptionalLowercaseString(channelId);
  if (!normalized) {
    return undefined;
  }
  return loadChannelMediaContractApi(normalized, resolver);
}

export function resolveChannelInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const contractApi = findChannelMediaContractApi(
    params.ctx.Surface ?? params.ctx.Provider,
    "resolveInboundAttachmentRoots",
  );
  if (contractApi?.resolveInboundAttachmentRoots) {
    return contractApi.resolveInboundAttachmentRoots({
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
    });
  }
  return undefined;
}

export function resolveChannelRemoteInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const contractApi = findChannelMediaContractApi(
    params.ctx.Surface ?? params.ctx.Provider,
    "resolveRemoteInboundAttachmentRoots",
  );
  if (contractApi?.resolveRemoteInboundAttachmentRoots) {
    return contractApi.resolveRemoteInboundAttachmentRoots({
      cfg: params.cfg,
      accountId: params.ctx.AccountId,
    });
  }
  return undefined;
}
