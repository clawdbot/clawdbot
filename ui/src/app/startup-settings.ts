import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
// Control UI startup settings resolve native auth handoff and URL parameters.
import {
  CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM,
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT,
  type ControlUiBootstrapProfileHint,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { inferBasePathFromPathname, sessionRouteNamespaceFromPath } from "../app-route-paths.ts";
import type { UiSettings } from "./settings.ts";

type ApplicationStartupLocation = {
  pathname: string;
  search: string;
  hash: string;
};

type NativeControlAuth = {
  gatewayUrl?: string | null;
  token?: string | null;
  password?: string | null;
};

type ApplicationStartupSettings = {
  settings: UiSettings;
  password: string | null;
  pendingGatewayUrl: string | null;
  pendingGatewayToken: string | null;
  pendingBootstrapToken: string | null;
  pendingBootstrapProfile: ControlUiBootstrapProfileHint | null;
  queryTokenUsed: boolean;
  location: ApplicationStartupLocation;
  changed: boolean;
};

declare global {
  interface Window {
    __OPENCLAW_NATIVE_CONTROL_AUTH__?: NativeControlAuth;
  }
}

export function normalizeLegacyTerminalViewLocation(
  location: ApplicationStartupLocation,
  basePath: string,
): ApplicationStartupLocation {
  const applicationRoot = basePath ? `${basePath}/` : "/";
  if (location.pathname !== applicationRoot) {
    return location;
  }
  const searchParams = new URLSearchParams(location.search);
  if (searchParams.get("view") !== "terminal") {
    return location;
  }
  searchParams.delete("view");
  const search = searchParams.toString();
  return {
    pathname: buildControlUiFocusPath({ kind: "terminal" }, basePath),
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
}

export function resolveApplicationStartupSettings(
  initialSettings: UiSettings,
  location: ApplicationStartupLocation,
): ApplicationStartupSettings {
  let settings = initialSettings;
  let changed = false;
  let password: string | null = null;
  let pendingGatewayUrl: string | null = null;
  let pendingGatewayToken: string | null = null;
  let pendingBootstrapToken: string | null = null;
  let pendingBootstrapProfile: ControlUiBootstrapProfileHint | null = null;
  let queryTokenUsed = false;

  const updateSettings = (patch: Partial<UiSettings>) => {
    const entries = Object.entries(patch) as Array<
      [keyof UiSettings, UiSettings[keyof UiSettings]]
    >;
    if (entries.every(([key, value]) => settings[key] === value)) {
      return;
    }
    settings = { ...settings, ...patch };
    changed = true;
  };

  const nativeAuth =
    typeof window === "undefined" ? undefined : window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
  if (nativeAuth) {
    try {
      delete window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
    } catch {
      window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = undefined;
    }

    const gatewayUrl = normalizeOptionalString(nativeAuth.gatewayUrl);
    const token = normalizeOptionalString(nativeAuth.token);
    const nativePassword = normalizeOptionalString(nativeAuth.password);
    updateSettings({
      ...(gatewayUrl ? { gatewayUrl } : {}),
      ...(token ? { token } : {}),
    });
    if (nativePassword) {
      password = nativePassword;
    }
  }

  if (!location.search && !location.hash) {
    return {
      settings,
      password,
      pendingGatewayUrl,
      pendingGatewayToken,
      pendingBootstrapToken,
      pendingBootstrapProfile,
      queryTokenUsed,
      location,
      changed,
    };
  }

  const url = new URL(
    `${location.pathname}${location.search}${location.hash}`,
    "http://openclaw.local",
  );
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
  const nextGatewayUrl = normalizeOptionalString(gatewayUrlRaw) ?? "";
  const gatewayUrlChanged = Boolean(nextGatewayUrl && nextGatewayUrl !== settings.gatewayUrl);
  const queryToken = params.get("token");
  const hashToken = hashParams.get("token");
  const hasTokenParam = hashToken != null || queryToken != null;
  const token = normalizeOptionalString(hashToken ?? queryToken);
  const hasBootstrapTokenParam = hashParams.has("bootstrapToken");
  const bootstrapToken = normalizeOptionalString(hashParams.get("bootstrapToken"));
  const hasBootstrapProfileParam = hashParams.has(CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM);
  const bootstrapProfile = normalizeOptionalString(
    hashParams.get(CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM),
  );
  const sessionPath = sessionRouteNamespaceFromPath(
    location.pathname,
    inferBasePathFromPathname(location.pathname),
  );
  const shouldResetSessionForToken = Boolean(token && !sessionPath && !gatewayUrlChanged);
  let shouldCleanUrl = false;

  if (params.has("token")) {
    params.delete("token");
    shouldCleanUrl = true;
  }

  if (hasTokenParam) {
    if (queryToken != null) {
      queryTokenUsed = true;
      console.warn(
        "[openclaw] Auth token passed as query parameter (?token=). Use URL fragment instead: #token=<token>. Query parameters may appear in server logs.",
      );
    }
    if (token && gatewayUrlChanged) {
      pendingGatewayToken = token;
    } else if (token) {
      updateSettings({ token });
    }
    hashParams.delete("token");
    shouldCleanUrl = true;
  }

  if (hasBootstrapTokenParam) {
    pendingBootstrapToken = bootstrapToken ?? null;
    pendingBootstrapProfile =
      bootstrapToken && bootstrapProfile === CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT
        ? CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT
        : null;
    hashParams.delete("bootstrapToken");
    shouldCleanUrl = true;
  }
  if (hasBootstrapProfileParam) {
    hashParams.delete(CONTROL_UI_BOOTSTRAP_PROFILE_FRAGMENT_PARAM);
    shouldCleanUrl = true;
  }

  if (shouldResetSessionForToken) {
    updateSettings({
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
  }

  if (params.has("password") || hashParams.has("password")) {
    params.delete("password");
    hashParams.delete("password");
    shouldCleanUrl = true;
  }

  if (gatewayUrlRaw != null) {
    pendingGatewayUrl = gatewayUrlChanged ? nextGatewayUrl : null;
    if (!gatewayUrlChanged) {
      pendingGatewayToken = null;
    } else if (pendingBootstrapToken) {
      pendingGatewayToken = null;
    }
    params.delete("gatewayUrl");
    hashParams.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (shouldCleanUrl) {
    url.search = params.toString();
    const nextHash = hashParams.toString();
    url.hash = nextHash ? `#${nextHash}` : "";
  }

  return {
    settings,
    password,
    pendingGatewayUrl,
    pendingGatewayToken,
    pendingBootstrapToken,
    pendingBootstrapProfile,
    queryTokenUsed,
    location: shouldCleanUrl
      ? {
          pathname: url.pathname,
          search: url.search,
          hash: url.hash,
        }
      : location,
    changed,
  };
}
