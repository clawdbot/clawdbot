import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type ThreadBindingPlacement = "current" | "child";

type ThreadBindingInboundConversationParams = {
  from?: string;
  to?: string;
  conversationId?: string;
  threadId?: string | number;
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
const threadBindingApiCache = new Map<string, ThreadBindingApi | undefined>();

function loadBundledChannelThreadBindingApi(channelId: string): ThreadBindingApi | undefined {
  const cacheKey = channelId.trim();
  if (threadBindingApiCache.has(cacheKey)) {
    return threadBindingApiCache.get(cacheKey);
  }
  try {
    const loaded = loadBundledPluginPublicArtifactModuleSync<ThreadBindingApi>({
      dirName: cacheKey,
      artifactBasename: THREAD_BINDING_API_ARTIFACT_BASENAME,
    });
    threadBindingApiCache.set(cacheKey, loaded);
    return loaded;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(MISSING_PUBLIC_SURFACE_PREFIX)) {
      threadBindingApiCache.set(cacheKey, undefined);
      return undefined;
    }
    throw error;
  }
}

function normalizeThreadBindingPlacement(value: unknown): ThreadBindingPlacement | undefined {
  const normalized = normalizeOptionalString(typeof value === "string" ? value : undefined);
  return normalized === "current" || normalized === "child" ? normalized : undefined;
}

export function resolveBundledChannelThreadBindingDefaultPlacement(
  channelId: string,
): ThreadBindingPlacement | undefined {
  return normalizeThreadBindingPlacement(
    loadBundledChannelThreadBindingApi(channelId)?.defaultTopLevelPlacement,
  );
}

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
    isGroup: params.isGroup,
  });
}

export const __testing = {
  clearThreadBindingApiCache: () => threadBindingApiCache.clear(),
};
