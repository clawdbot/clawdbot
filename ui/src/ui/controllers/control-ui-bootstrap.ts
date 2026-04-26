import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiBootstrapConfig,
  type ControlUiEmbedSandboxMode,
} from "../../../../src/gateway/control-ui-contract.js";
import { normalizeAssistantIdentity } from "../assistant-identity.ts";
import { resolveControlUiAuthCandidates } from "../control-ui-auth.ts";
import { normalizeBasePath } from "../navigation.ts";
import { loadLocalAssistantIdentity } from "../storage.ts";

export type ControlUiBootstrapState = {
  basePath: string;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarSource?: string | null;
  assistantAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  assistantAvatarReason?: string | null;
  assistantAgentId: string | null;
  serverVersion: string | null;
  localMediaPreviewRoots: string[];
  embedSandboxMode: ControlUiEmbedSandboxMode;
  allowExternalEmbedUrls: boolean;
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

export async function loadControlUiBootstrapConfig(state: ControlUiBootstrapState) {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof fetch !== "function") {
    return;
  }

  const basePath = normalizeBasePath(state.basePath ?? "");
  const url = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;

  try {
    const resolvedUrl = new URL(url, window.location.origin);
    const sameOrigin = resolvedUrl.origin === window.location.origin;
    const authCandidates = sameOrigin ? resolveControlUiAuthCandidates(state) : [];
    // If credentials are available, try them in priority order; on 401/403
    // retry with the next candidate — recovers from a stale `settings.token`
    // when the live session is authenticated via `password` (or vice versa).
    // If no credentials are available, fall through with no Authorization
    // header so bootstrap still works on auth-disabled deployments.
    const attempts: string[] = authCandidates.length > 0 ? authCandidates : [""];
    let res: Response | null = null;
    for (const candidate of attempts) {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (candidate) {
        headers.Authorization = `Bearer ${candidate}`;
      }
      res = await fetch(url, { method: "GET", headers, credentials: "same-origin" });
      if (res.ok) {
        break;
      }
      if (res.status !== 401 && res.status !== 403) {
        return;
      }
    }
    if (!res || !res.ok) {
      return;
    }
    const parsed = (await res.json()) as ControlUiBootstrapConfig;
    const normalized = normalizeAssistantIdentity({
      agentId: parsed.assistantAgentId ?? null,
      name: parsed.assistantName,
      avatar: parsed.assistantAvatar ?? null,
      avatarSource: parsed.assistantAvatarSource ?? null,
      avatarStatus: parsed.assistantAvatarStatus ?? null,
      avatarReason: parsed.assistantAvatarReason ?? null,
    });
    state.assistantName = normalized.name;
    state.assistantAvatar = normalized.avatar;
    state.assistantAvatarSource = normalized.avatarSource ?? null;
    state.assistantAvatarStatus = normalized.avatarStatus ?? null;
    state.assistantAvatarReason = normalized.avatarReason ?? null;
    state.assistantAgentId = normalized.agentId ?? null;
    // Local override always wins — same pattern as the user avatar.
    const localAvatar = loadLocalAssistantIdentity().avatar;
    if (localAvatar) {
      state.assistantAvatar = localAvatar;
      state.assistantAvatarSource = localAvatar;
      state.assistantAvatarStatus = "data";
      state.assistantAvatarReason = null;
    }
    state.serverVersion = parsed.serverVersion ?? null;
    state.localMediaPreviewRoots = Array.isArray(parsed.localMediaPreviewRoots)
      ? parsed.localMediaPreviewRoots.filter((value): value is string => typeof value === "string")
      : [];
    state.embedSandboxMode =
      parsed.embedSandbox === "trusted"
        ? "trusted"
        : parsed.embedSandbox === "strict"
          ? "strict"
          : "scripts";
    state.allowExternalEmbedUrls = parsed.allowExternalEmbedUrls === true;
  } catch {
    // Ignore bootstrap failures; UI will update identity after connecting.
  }
}
