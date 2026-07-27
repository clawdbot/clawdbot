// Gateway assistant-avatar projection binds the selected value to effective metadata.
import fs from "node:fs";
import {
  openLocalAgentAvatarFile,
  readOpenedLocalAgentAvatarDataUrl,
  type OpenedLocalAgentAvatarFile,
} from "../agents/identity-avatar-file.js";
import type { AgentAvatarResolution } from "../agents/identity-avatar.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRenderableAvatarImageDataUrl } from "../shared/avatar-limits.js";
import {
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isWindowsAbsolutePath,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";
import { DEFAULT_ASSISTANT_IDENTITY } from "./assistant-identity.js";
import { CONTROL_UI_AVATAR_PREFIX, normalizeControlUiBasePath } from "./control-ui-shared.js";

type GatewayAssistantIdentity = {
  agentId: string;
  avatar: string;
  emoji?: string;
};

type GatewayAssistantAvatarProjection = {
  avatar: string;
  resolution: AgentAvatarResolution | null;
};

type OpenGatewayAssistantAvatarProjection = {
  resolution: AgentAvatarResolution | null;
  openedFile?: OpenedLocalAgentAvatarFile;
};

type AvatarDataUrlCacheEntry = {
  ctimeMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  dataUrl: string;
};

const GATEWAY_AVATAR_DATA_URL_CACHE_MAX_ENTRIES = 4;

export function createGatewayAvatarDataUrlCache(params?: {
  maxEntries?: number;
  read?: (opened: OpenedLocalAgentAvatarFile) => string | undefined;
  close?: (fd: number) => void;
}) {
  const maxEntries = params?.maxEntries ?? GATEWAY_AVATAR_DATA_URL_CACHE_MAX_ENTRIES;
  const read = params?.read ?? readOpenedLocalAgentAvatarDataUrl;
  const close = params?.close ?? ((fd: number) => fs.closeSync(fd));
  const entries = new Map<string, AvatarDataUrlCacheEntry>();
  return {
    read(opened: OpenedLocalAgentAvatarFile): string | undefined {
      const cached = entries.get(opened.path);
      if (
        cached &&
        cached.ctimeMs === opened.stat.ctimeMs &&
        cached.dev === opened.stat.dev &&
        cached.ino === opened.stat.ino &&
        cached.mtimeMs === opened.stat.mtimeMs &&
        cached.size === opened.stat.size
      ) {
        close(opened.fd);
        entries.delete(opened.path);
        entries.set(opened.path, cached);
        return cached.dataUrl;
      }
      entries.delete(opened.path);
      const dataUrl = read(opened);
      if (!dataUrl || maxEntries <= 0) {
        return dataUrl;
      }
      // The boundary-safe open already fstats the pinned descriptor. Reuse base64
      // only while its file identity and mtime/size match; otherwise an atomic
      // same-size replacement could leave stale identity data indefinitely.
      entries.set(opened.path, {
        ctimeMs: opened.stat.ctimeMs,
        dev: opened.stat.dev,
        ino: opened.stat.ino,
        mtimeMs: opened.stat.mtimeMs,
        size: opened.stat.size,
        dataUrl,
      });
      while (entries.size > maxEntries) {
        const oldestPath = entries.keys().next().value;
        if (oldestPath === undefined) {
          break;
        }
        entries.delete(oldestPath);
      }
      return dataUrl;
    },
  };
}

const gatewayAvatarDataUrlCache = createGatewayAvatarDataUrlCache();

function resolveSameOriginAvatarUrl(cfg: OpenClawConfig, source: string): string | undefined {
  const basePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
  const unbasedPrefix = `${CONTROL_UI_AVATAR_PREFIX}/`;
  const basedPrefix = basePath ? `${basePath}${unbasedPrefix}` : unbasedPrefix;
  if (basePath && source.startsWith(unbasedPrefix)) {
    return `${basePath}${source}`;
  }
  return source.startsWith(basedPrefix) ? source : undefined;
}

/**
 * Resolve and open a selected local avatar for route delivery.
 * A projection with `openedFile` transfers fd ownership to the caller.
 */
export function openGatewayAssistantAvatar(params: {
  cfg: OpenClawConfig;
  identity: GatewayAssistantIdentity;
}): OpenGatewayAssistantAvatarProjection {
  const { cfg, identity } = params;
  const source = identity.avatar;
  if (isAvatarHttpUrl(source)) {
    return { resolution: { kind: "remote", url: source, source } };
  }
  if (isRenderableAvatarImageDataUrl(source)) {
    return { resolution: { kind: "data", url: source, source } };
  }
  if (isAvatarDataUrl(source)) {
    return { resolution: { kind: "none", reason: "unsupported_data_url", source } };
  }
  if (hasAvatarUriScheme(source) && !isWindowsAbsolutePath(source)) {
    return { resolution: { kind: "none", reason: "unsupported_uri", source } };
  }
  if (resolveSameOriginAvatarUrl(cfg, source)) {
    return { resolution: null };
  }
  if (!looksLikeAvatarPath(source)) {
    return { resolution: null };
  }

  const opened = openLocalAgentAvatarFile({ cfg, agentId: identity.agentId, source });
  if (!opened.ok) {
    return { resolution: { kind: "none", reason: opened.reason, source } };
  }
  return {
    resolution: { kind: "local", filePath: opened.file.path, source },
    openedFile: opened.file,
  };
}

/** Resolve one selected identity avatar and its matching public metadata. */
export function resolveGatewayAssistantAvatar(params: {
  cfg: OpenClawConfig;
  identity: GatewayAssistantIdentity;
}): GatewayAssistantAvatarProjection {
  const { cfg, identity } = params;
  const source = identity.avatar;
  const sameOriginAvatarUrl = resolveSameOriginAvatarUrl(cfg, source);
  if (sameOriginAvatarUrl) {
    return { avatar: sameOriginAvatarUrl, resolution: null };
  }
  const opened = openGatewayAssistantAvatar(params);
  if (opened.resolution?.kind === "none") {
    return {
      avatar: identity.emoji ?? DEFAULT_ASSISTANT_IDENTITY.avatar,
      resolution: opened.resolution,
    };
  }
  if (!opened.openedFile) {
    return { avatar: source, resolution: opened.resolution };
  }

  const dataUrl = gatewayAvatarDataUrlCache.read(opened.openedFile);
  if (!dataUrl) {
    return {
      avatar: identity.emoji ?? DEFAULT_ASSISTANT_IDENTITY.avatar,
      resolution: { kind: "none", reason: "unreadable", source },
    };
  }
  return {
    avatar: dataUrl,
    resolution: opened.resolution,
  };
}
