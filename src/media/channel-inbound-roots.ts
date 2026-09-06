// Channel inbound root helpers resolve media roots for channel-delivered files.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";

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

function loadChannelMediaContractApi(
  channelId: string,
  resolver: ChannelMediaRootResolver,
): ChannelMediaContractApi | undefined {
  try {
    // Media-root resolution must stay a narrow artifact load, not full channel bootstrap.
    const loaded = loadBundledPluginPublicArtifactModuleSync<ChannelMediaContractApi>({
      dirName: channelId,
      artifactBasename: "media-contract-api.js",
    });
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

/** Resolves local inbound attachment roots from the channel named in a message context. */
export function resolveChannelInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  return resolveChannelInboundAttachmentRootsForChannel({
    cfg: params.cfg,
    channelId: params.ctx.Surface ?? params.ctx.Provider,
    accountId: params.ctx.AccountId,
  });
}

/** Resolves local inbound attachment roots for callers that already know the channel id. */
export function resolveChannelInboundAttachmentRootsForChannel(params: {
  cfg: OpenClawConfig;
  channelId?: string | null;
  accountId?: string | null;
}): readonly string[] | undefined {
  const contractApi = findChannelMediaContractApi(
    params.channelId,
    "resolveInboundAttachmentRoots",
  );
  if (contractApi?.resolveInboundAttachmentRoots) {
    return contractApi.resolveInboundAttachmentRoots({
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
    });
  }
  return undefined;
}

/** Resolves remote staging roots for inbound channel attachments without loading full channel code. */
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
