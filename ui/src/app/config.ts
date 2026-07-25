import { normalizeRouteBasePath } from "@openclaw/uirouter";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE,
  type ControlUiBootstrapConfig,
  type ControlUiEmbedSandboxMode,
  type ControlUiPluginFrameGrantAck,
} from "../../../src/gateway/control-ui-contract.js";
import { normalizeAssistantIdentity } from "../lib/assistant-identity.ts";
import { setUiTimeFormatPreference } from "../lib/format.ts";
import { resolveControlUiAuthCandidates } from "./control-ui-auth.ts";

type ApplicationConfigAuthSource = {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

const SEAM_COLOR_CSS_VARIABLES = [
  "--ring",
  "--accent",
  "--accent-hover",
  "--accent-muted",
  "--accent-subtle",
  "--accent-glow",
  "--primary",
  "--focus",
  "--focus-ring",
  "--focus-glow",
] as const;

type ApplicationConfig = {
  assistantIdentity: {
    agentId: string | null;
    name: string;
    avatar: string | null;
    avatarSource: string | null;
    avatarStatus: "none" | "local" | "remote" | "data" | null;
    avatarReason: string | null;
  };
  serverVersion: string | null;
  devGitBranch: string | null;
  localMediaPreviewRoots: string[];
  embedSandboxMode: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  terminalEnabled: boolean;
  pluginFrameGrants: ControlUiPluginFrameGrantAck[];
};

export type ApplicationConfigCapability = {
  readonly current: ApplicationConfig;
  refresh: (options?: {
    auth?: ApplicationConfigAuthSource;
    skipWithoutAuthCandidate?: boolean;
    signal?: AbortSignal;
  }) => Promise<ApplicationConfig | null>;
  subscribe: (listener: (config: ApplicationConfig) => void) => () => void;
};

function readDocumentTerminalEnabled(): boolean | null {
  if (typeof document === "undefined") {
    return null;
  }
  const value = document.documentElement.getAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE);
  return value === "true" ? true : value === "false" ? false : null;
}

const DEFAULT_APPLICATION_CONFIG: ApplicationConfig = {
  assistantIdentity: {
    agentId: null,
    name: "Assistant",
    avatar: null,
    avatarSource: null,
    avatarStatus: null,
    avatarReason: null,
  },
  serverVersion: null,
  devGitBranch: null,
  localMediaPreviewRoots: [],
  embedSandboxMode: "strict",
  allowExternalEmbedUrls: false,
  terminalEnabled: readDocumentTerminalEnabled() ?? false,
  pluginFrameGrants: [],
};

function normalizeSeamColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const hex = value.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

function applyControlUiSeamColor(value: unknown): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const color = normalizeSeamColor(value);
  if (!color) {
    for (const property of SEAM_COLOR_CSS_VARIABLES) {
      root.style.removeProperty(property);
    }
    return;
  }

  root.style.setProperty("--ring", color);
  root.style.setProperty("--accent", color);
  root.style.setProperty("--accent-hover", "color-mix(in srgb, var(--accent) 82%, white 18%)");
  root.style.setProperty("--accent-muted", color);
  root.style.setProperty("--accent-subtle", "color-mix(in srgb, var(--accent) 16%, transparent)");
  root.style.setProperty("--accent-glow", "color-mix(in srgb, var(--accent) 30%, transparent)");
  root.style.setProperty("--primary", color);
  root.style.setProperty("--focus", "color-mix(in srgb, var(--ring) 22%, transparent)");
  root.style.setProperty(
    "--focus-ring",
    "0 0 0 2px var(--bg), 0 0 0 3px color-mix(in srgb, var(--ring) 80%, transparent)",
  );
  root.style.setProperty(
    "--focus-glow",
    "0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)",
  );
}

function normalizeApplicationConfig(parsed: ControlUiBootstrapConfig): ApplicationConfig {
  const identity = normalizeAssistantIdentity({
    agentId: parsed.assistantAgentId ?? null,
    name: parsed.assistantName,
    avatar: parsed.assistantAvatar ?? null,
    avatarSource: parsed.assistantAvatarSource ?? null,
    avatarStatus: parsed.assistantAvatarStatus ?? null,
    avatarReason: parsed.assistantAvatarReason ?? null,
  });
  return {
    assistantIdentity: {
      agentId: identity.agentId ?? null,
      name: identity.name,
      avatar: identity.avatar,
      avatarSource: identity.avatarSource ?? null,
      avatarStatus: identity.avatarStatus ?? null,
      avatarReason: identity.avatarReason ?? null,
    },
    serverVersion: parsed.serverVersion ?? null,
    devGitBranch:
      typeof parsed.devGitBranch === "string" && parsed.devGitBranch.trim()
        ? parsed.devGitBranch.trim()
        : null,
    localMediaPreviewRoots: Array.isArray(parsed.localMediaPreviewRoots)
      ? parsed.localMediaPreviewRoots.filter((value): value is string => typeof value === "string")
      : [],
    embedSandboxMode:
      parsed.embedSandbox === "trusted"
        ? "trusted"
        : parsed.embedSandbox === "strict"
          ? "strict"
          : "scripts",
    allowExternalEmbedUrls: parsed.allowExternalEmbedUrls === true,
    terminalEnabled: parsed.terminalEnabled === true,
    pluginFrameGrants: Array.isArray(parsed.pluginFrameGrants)
      ? parsed.pluginFrameGrants.filter(
          (grant): grant is ControlUiPluginFrameGrantAck =>
            typeof grant?.pluginId === "string" &&
            typeof grant.path === "string" &&
            (grant.match === "exact" || grant.match === "prefix"),
        )
      : [],
  };
}

async function loadApplicationConfig(params: {
  basePath: string;
  auth?: ApplicationConfigAuthSource;
  skipWithoutAuthCandidate?: boolean;
  signal?: AbortSignal;
}): Promise<ApplicationConfig | null> {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return null;
  }

  const basePath = normalizeRouteBasePath(params.basePath);
  const url = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;

  try {
    const resolvedUrl = new URL(url, window.location.origin);
    const sameOrigin = resolvedUrl.origin === window.location.origin;
    const authCandidates = sameOrigin ? resolveControlUiAuthCandidates(params.auth ?? {}) : [];
    if (params.skipWithoutAuthCandidate && sameOrigin && authCandidates.length === 0) {
      return null;
    }
    const attempts = authCandidates.length > 0 ? authCandidates : [""];
    let res: Response | null = null;
    for (const candidate of attempts) {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (candidate) {
        headers.Authorization = `Bearer ${candidate}`;
      }
      res = await fetch(url, {
        method: "GET",
        headers,
        credentials: "same-origin",
        signal: params.signal,
      });
      if (res.ok) {
        break;
      }
      if (res.status !== 401 && res.status !== 403) {
        return null;
      }
    }
    if (!res || !res.ok) {
      return null;
    }
    const parsed = (await res.json()) as ControlUiBootstrapConfig;
    setUiTimeFormatPreference(parsed.timeFormat);
    applyControlUiSeamColor(parsed.seamColor);
    return normalizeApplicationConfig(parsed);
  } catch {
    return null;
  }
}

export function createApplicationConfigCapability(params: {
  basePath: string;
  auth?: ApplicationConfigAuthSource;
}): ApplicationConfigCapability {
  let current = DEFAULT_APPLICATION_CONFIG;
  let currentAuth = params.auth;
  let refreshVersion = 0;
  const listeners = new Set<(config: ApplicationConfig) => void>();

  const publish = (next: ApplicationConfig) => {
    current = next;
    for (const listener of listeners) {
      listener(current);
    }
  };

  return {
    get current() {
      return current;
    },
    async refresh(options) {
      currentAuth = options?.auth ?? currentAuth;
      const version = ++refreshVersion;
      const next = await loadApplicationConfig({
        basePath: params.basePath,
        auth: currentAuth,
        skipWithoutAuthCandidate: options?.skipWithoutAuthCandidate,
        signal: options?.signal,
      });
      if (!next || version !== refreshVersion) {
        return null;
      }
      const documentTerminalEnabled = readDocumentTerminalEnabled();
      if (documentTerminalEnabled !== null && next.terminalEnabled !== documentTerminalEnabled) {
        // CSP headers cannot change on a live document. Reload in either
        // direction so the document and accepted terminal state stay aligned.
        window.location.reload();
        return next;
      }
      publish(next);
      return next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
