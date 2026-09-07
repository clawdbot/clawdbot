/** Browser tool lifecycle and host-local profile discovery/import actions. */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";
import { resolveBrowserBaseUrl } from "./browser-tool.routing.js";
import {
  browserDoctor,
  browserImportProfile,
  browserProfiles,
  browserSystemProfiles,
  browserStart,
  browserStatus,
  browserStop,
  jsonResult,
  normalizeOptionalString,
} from "./browser-tool.runtime.js";
import { parseSystemProfileDomains } from "./browser/system-profile-domains.js";

const unavailableSystemProfiles = (unavailableReason: string) => ({
  profiles: [],
  unavailableReason,
});

/**
 * Read importable system profiles from the host control server. Discovery must
 * match where import runs (host-local), so it never uses a node proxy or the
 * sandbox base URL. Other profile sources remain useful when host discovery
 * is unavailable, so failures become an explicit degradation fact.
 */
async function readHostSystemProfiles(params: {
  allowHostControl?: boolean;
  sandboxBridgeUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  if (params.allowHostControl === false) {
    return unavailableSystemProfiles(
      "Host system profile discovery is disabled by sandbox policy; enable host control to discover importable system profiles.",
    );
  }
  let hostBaseUrl: string | undefined;
  try {
    hostBaseUrl = resolveBrowserBaseUrl({
      target: "host",
      sandboxBridgeUrl: params.sandboxBridgeUrl,
      allowHostControl: params.allowHostControl,
    });
  } catch {
    return unavailableSystemProfiles(
      'Host browser control is unavailable; enable it and retry action=profiles target="host".',
    );
  }
  try {
    return {
      profiles: await browserSystemProfiles(hostBaseUrl, {
        timeoutMs: params.timeoutMs,
        signal: params.signal,
      }),
      unavailableReason: undefined,
    };
  } catch {
    params.signal?.throwIfAborted();
    return unavailableSystemProfiles(
      'Host system profile discovery failed; retry action=profiles target="host" after host browser control is available.',
    );
  }
}

export async function executeBrowserLifecycleAction({
  action,
  input: params,
  baseUrl,
  profile,
  timeoutMs: toolTimeoutMs,
  proxyRequest,
  allowHostControl,
  sandboxBridgeUrl,
  signal,
}: {
  action: "doctor" | "status" | "start" | "stop" | "profiles" | "importprofile";
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  timeoutMs?: number;
  proxyRequest: BrowserProxyRequest | null;
  allowHostControl?: boolean;
  sandboxBridgeUrl?: string;
  signal?: AbortSignal;
}): Promise<AgentToolResult<unknown>> {
  const readBrowserStatus = async () =>
    proxyRequest
      ? await proxyRequest({
          method: "GET",
          path: "/",
          profile,
          timeoutMs: toolTimeoutMs,
        })
      : await browserStatus(baseUrl, {
          profile,
          timeoutMs: toolTimeoutMs,
          signal,
        });
  switch (action) {
    case "doctor":
      return jsonResult(
        proxyRequest
          ? await proxyRequest({ method: "GET", path: "/doctor", profile })
          : await browserDoctor(baseUrl, { profile, signal }),
      );
    case "status":
      return jsonResult(await readBrowserStatus());
    case "start":
    case "stop": {
      if (proxyRequest) {
        await proxyRequest({
          method: "POST",
          path: `/${action}`,
          profile,
          timeoutMs: toolTimeoutMs,
        });
      } else {
        const updateBrowser = action === "start" ? browserStart : browserStop;
        await updateBrowser(baseUrl, { profile, timeoutMs: toolTimeoutMs, signal });
      }
      return jsonResult(await readBrowserStatus());
    }
    case "profiles": {
      // Importable system profiles are host-local (import runs on the host),
      // so read them from the host regardless of the profiles action target;
      // never let a node proxy or sandbox describe the wrong Chrome profiles.
      const { profiles: systemProfiles, unavailableReason: systemProfilesUnavailable } =
        await readHostSystemProfiles({
          allowHostControl,
          sandboxBridgeUrl,
          timeoutMs: toolTimeoutMs,
          signal,
        });
      if (proxyRequest) {
        const result = await proxyRequest({
          method: "GET",
          path: "/profiles",
          timeoutMs: toolTimeoutMs,
        });
        return jsonResult({
          ...(result && typeof result === "object" ? result : { profiles: result }),
          systemProfiles,
          ...(systemProfilesUnavailable ? { systemProfilesUnavailable } : {}),
        });
      }
      return jsonResult({
        profiles: await browserProfiles(baseUrl, {
          timeoutMs: toolTimeoutMs,
          signal,
        }),
        systemProfiles,
        ...(systemProfilesUnavailable ? { systemProfilesUnavailable } : {}),
      });
    }
    case "importprofile": {
      if (proxyRequest) {
        throw new Error("system profile import must run on the browser host");
      }
      const domains = parseSystemProfileDomains(params.domains);
      return jsonResult(
        await browserImportProfile(baseUrl, {
          browser: normalizeOptionalString(params.browser) ?? "chrome",
          systemProfile: normalizeOptionalString(params.systemProfile) ?? "Default",
          into: normalizeOptionalString(params.into) ?? "imported",
          domains,
          signal,
        }),
      );
    }
    default:
      throw new Error(`Unknown action: ${String(action)}`);
  }
}
