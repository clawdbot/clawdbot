/** Lifetime shared by server-minted plugin-tab grants and parent-side renewal. */
export const CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS = 5 * 60 * 1000;

/** Reserved query key for the sandbox cookie capability probe. */
export const CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY = "__openclaw_plugin_frame_auth_probe";

/** Exact parent origin that may receive the successful probe message. */
export const CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY = "__openclaw_plugin_frame_auth_origin";

/** Message emitted only by a successful sandbox cookie capability probe. */
export const CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE = "openclaw-plugin-frame-auth-probe";

/** Extracts the same-origin route pathname from a tab descriptor URL. */
export function resolveControlUiPluginTabPathname(path: string): string | undefined {
  try {
    const baseUrl = new URL("http://openclaw.invalid");
    const tabUrl = new URL(path, baseUrl);
    return tabUrl.origin === baseUrl.origin ? tabUrl.pathname : undefined;
  } catch {
    return undefined;
  }
}
