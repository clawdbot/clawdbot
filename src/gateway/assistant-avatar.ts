// Gateway assistant-avatar projection binds the selected value to effective metadata.
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  openLocalAgentAvatarFile,
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
import { createGatewayAvatarDataUrlCache } from "./assistant-avatar-cache.js";
import { DEFAULT_ASSISTANT_IDENTITY } from "./assistant-identity.js";
import { buildControlUiResourcePath, matchControlUiResourceUrl } from "./control-ui-contract.js";

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

const gatewayAvatarDataUrlCache = createGatewayAvatarDataUrlCache();

function resolveSameOriginAvatarUrl(
  basePath: string | undefined,
  source: string,
): string | undefined {
  const unbased = matchControlUiResourceUrl("agentAvatar", source);
  if (unbased) {
    return `${buildControlUiResourcePath("agentAvatar", basePath, unbased.value)}${unbased.search}${unbased.hash}`;
  }
  return matchControlUiResourceUrl("agentAvatar", source, basePath) ? source : undefined;
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
  if (resolveSameOriginAvatarUrl(cfg.gateway?.controlUi?.basePath, source)) {
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
  /** HTTP bootstrap uses authenticated image bytes; RPC clients retain inline avatars. */
  httpBasePath?: string;
}): GatewayAssistantAvatarProjection {
  const { cfg, identity } = params;
  const source = identity.avatar;
  const sameOriginAvatarUrl = resolveSameOriginAvatarUrl(
    params.httpBasePath ?? cfg.gateway?.controlUi?.basePath,
    source,
  );
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

  if (params.httpBasePath !== undefined) {
    fs.closeSync(opened.openedFile.fd);
    // Opaque file identity invalidates the browser's authenticated blob cache
    // after replacement, without exposing a path or reading image bytes at boot.
    const revision = createHash("sha256")
      .update(JSON.stringify([opened.openedFile.path, opened.openedFile.stat]))
      .digest("hex")
      .slice(0, 16);
    return {
      avatar: `${buildControlUiResourcePath("agentAvatar", params.httpBasePath, identity.agentId)}?v=${revision}`,
      resolution: opened.resolution,
    };
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
