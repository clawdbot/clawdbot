import { normalizeRouteBasePath } from "@openclaw/uirouter";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_ENVIRONMENT_ATTRIBUTE,
  CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE,
  type ControlUiBootstrapConfig,
  type ControlUiEmbedSandboxMode,
  type ControlUiEnvironment,
  type ControlUiPluginFrameGrantAck,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { normalizeAssistantIdentity } from "../lib/assistant-identity.ts";
import { resolveControlUiAuthCandidates } from "./control-ui-auth.ts";

type ApplicationConfigAuthSource = {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

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
  serverBuildId?: string | null;
  devGitBranch: string | null;
  environment: ControlUiEnvironment | null;
  localMediaPreviewRoots: string[];
  embedSandboxMode: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  automaticallyFetchFavicons: boolean;
  terminalEnabled: boolean;
  cliAgentsEnabled?: boolean;
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
  assistantIdentity: normalizeAssistantIdentity(),
  serverVersion: null,
  serverBuildId: null,
  devGitBranch: null,
  environment: null,
  localMediaPreviewRoots: [],
  embedSandboxMode: "strict",
  allowExternalEmbedUrls: false,
  automaticallyFetchFavicons: false,
  terminalEnabled: readDocumentTerminalEnabled() ?? false,
  cliAgentsEnabled: false,
  pluginFrameGrants: [],
};

function loadControlUiPresentation(environment: ControlUiEnvironment | null, seamColor?: string) {
  const root = document.documentElement;
  if (
    environment ||
    seamColor ||
    root.hasAttribute(CONTROL_UI_ENVIRONMENT_ATTRIBUTE) ||
    root.style.getPropertyValue("--ring")
  ) {
    void import("./control-ui-environment-presentation.runtime.ts").then(
      ({ applyControlUiPresentation }) => applyControlUiPresentation({ environment, seamColor }),
    );
  }
}

function normalizeApplicationConfig(parsed: ControlUiBootstrapConfig): ApplicationConfig {
  return {
    assistantIdentity: normalizeAssistantIdentity({
      agentId: parsed.assistantAgentId,
      name: parsed.assistantName,
      avatar: parsed.assistantAvatar,
      avatarSource: parsed.assistantAvatarSource,
      avatarStatus: parsed.assistantAvatarStatus,
      avatarReason: parsed.assistantAvatarReason,
    }),
    serverVersion: parsed.serverVersion ?? null,
    serverBuildId: parsed.serverBuildId ?? null,
    devGitBranch: parsed.devGitBranch?.trim() || null,
    environment: parsed.environment ?? null,
    localMediaPreviewRoots: parsed.localMediaPreviewRoots ?? [],
    embedSandboxMode: parsed.embedSandbox ?? "scripts",
    allowExternalEmbedUrls: Boolean(parsed.allowExternalEmbedUrls),
    automaticallyFetchFavicons: Boolean(parsed.automaticallyFetchFavicons),
    terminalEnabled: Boolean(parsed.terminalEnabled),
    cliAgentsEnabled: Boolean(parsed.cliAgentsEnabled),
    pluginFrameGrants: (parsed.pluginFrameGrants ?? []).filter(
      (grant): grant is ControlUiPluginFrameGrantAck =>
        typeof grant?.pluginId === "string" &&
        typeof grant.path === "string" &&
        (grant.match === "exact" || grant.match === "prefix"),
    ),
  };
}

async function loadApplicationConfig(params: {
  resourceBasePath: string;
  auth?: ApplicationConfigAuthSource;
  skipWithoutAuthCandidate?: boolean;
  signal?: AbortSignal;
}): Promise<ApplicationConfig | null> {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return null;
  }

  const url = `${normalizeRouteBasePath(params.resourceBasePath)}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`;

  try {
    const sameOrigin = new URL(url, window.location.origin).origin === window.location.origin;
    const authCandidates = sameOrigin ? resolveControlUiAuthCandidates(params.auth ?? {}) : [];
    if (params.skipWithoutAuthCandidate && sameOrigin && !authCandidates.length) {
      return null;
    }
    let res: Response | null = null;
    for (const candidate of authCandidates.length ? authCandidates : [""]) {
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
    if (!res?.ok) {
      return null;
    }
    const parsed = (await res.json()) as ControlUiBootstrapConfig;
    const config = normalizeApplicationConfig(parsed);
    loadControlUiPresentation(config.environment, parsed.seamColor);
    return config;
  } catch {
    return null;
  }
}

export function createApplicationConfigCapability(params: {
  resourceBasePath: string;
  auth?: ApplicationConfigAuthSource;
}): ApplicationConfigCapability {
  let current = DEFAULT_APPLICATION_CONFIG;
  const environmentAttribute = document.documentElement.getAttribute(
    CONTROL_UI_ENVIRONMENT_ATTRIBUTE,
  );
  if (environmentAttribute) {
    current = {
      ...current,
      environment: JSON.parse(environmentAttribute),
    };
    loadControlUiPresentation(current.environment);
  }
  let currentAuth = params.auth;
  let refreshVersion = 0;
  const listeners = new Set<(config: ApplicationConfig) => void>();

  return {
    get current() {
      return current;
    },
    async refresh(options) {
      currentAuth = options?.auth ?? currentAuth;
      const version = ++refreshVersion;
      const next = await loadApplicationConfig({
        resourceBasePath: params.resourceBasePath,
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
      current = next;
      for (const listener of listeners) {
        listener(current);
      }
      return next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
