/**
 * Bundled channel thread-binding public artifact loader.
 *
 * Reads lightweight thread placement and inbound conversation hooks without full plugin loading.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";

type ThreadBindingPlacement = "current" | "child";

type ThreadBindingInboundConversationParams = {
  from?: string;
  to?: string;
  conversationId?: string;
  threadId?: string | number;
  threadParentId?: string | number;
  isGroup: boolean;
};

type ThreadBindingConversationRef = {
  conversationId?: string;
  parentConversationId?: string;
};

type ThreadBindingApi = {
  defaultTopLevelPlacement?: unknown;
  resolveInboundConversation?: (
    params: ThreadBindingInboundConversationParams,
  ) => ThreadBindingConversationRef | null;
};

const THREAD_BINDING_API_ARTIFACT_BASENAME = "thread-binding-api.js";
const MISSING_PUBLIC_SURFACE_PREFIX = "Unable to resolve bundled plugin public surface ";

function loadBundledChannelThreadBindingApi(channelId: string): ThreadBindingApi | undefined {
  const cacheKey = channelId.trim();
  try {
    return loadBundledPluginPublicArtifactModuleSync<ThreadBindingApi>({
      dirName: cacheKey,
      artifactBasename: THREAD_BINDING_API_ARTIFACT_BASENAME,
    });
  } catch (error) {
    // Missing artifacts are optional; broken artifacts should surface so
    // bundled thread-binding contracts do not fail silently.
    if (error instanceof Error && error.message.startsWith(MISSING_PUBLIC_SURFACE_PREFIX)) {
      return undefined;
    }
    throw error;
  }
}

function normalizeThreadBindingPlacement(value: unknown): ThreadBindingPlacement | undefined {
  const normalized = normalizeOptionalString(typeof value === "string" ? value : undefined);
  return normalized === "current" || normalized === "child" ? normalized : undefined;
}

/**
 * Resolves the default top-level thread-binding placement for a bundled channel.
 */
export function resolveBundledChannelThreadBindingDefaultPlacement(
  channelId: string,
): ThreadBindingPlacement | undefined {
  return normalizeThreadBindingPlacement(
    loadBundledChannelThreadBindingApi(channelId)?.defaultTopLevelPlacement,
  );
}

/**
 * Resolves inbound conversation refs from a bundled channel thread-binding artifact.
 */
export function resolveBundledChannelThreadBindingInboundConversation(
  params: ThreadBindingInboundConversationParams & { channelId: string },
): ThreadBindingConversationRef | null | undefined {
  const api = loadBundledChannelThreadBindingApi(params.channelId);
  if (typeof api?.resolveInboundConversation !== "function") {
    return undefined;
  }
  return api.resolveInboundConversation({
    from: params.from,
    to: params.to,
    conversationId: params.conversationId,
    threadId: params.threadId,
    threadParentId: params.threadParentId,
    isGroup: params.isGroup,
  });
}
