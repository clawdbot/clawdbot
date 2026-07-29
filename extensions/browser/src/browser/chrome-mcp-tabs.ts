// Owns Chrome MCP availability, tab listing, ownership, and page creation.
import { randomUUID } from "node:crypto";
import {
  appendCdpPath,
  fetchJson,
  fetchOk,
  normalizeCdpHttpBaseForJsonEndpoints,
  resolveCdpTabOwnership,
} from "./cdp.helpers.js";
import { resolveChromeMcpNavigateCallTimeoutMs } from "./chrome-mcp-actions.js";
import {
  CHROME_MCP_NAVIGATE_TIMEOUT_MS,
  CHROME_MCP_NEW_PAGE_TIMEOUT_MS,
  ChromeMcpReconnectRequiredError,
  type ChromeMcpCallOptions,
  type ChromeMcpOpenOptions,
  type ChromeMcpOperationOptions,
  type ChromeMcpProfileOptions,
} from "./chrome-mcp-contracts.js";
import { cacheKeyMatchesProfileName } from "./chrome-mcp-options.js";
import { cleanupTarget } from "./chrome-mcp-process.js";
import { extractStructuredPages } from "./chrome-mcp-result.js";
import {
  callTool,
  clearChromeMcpSnapshotRefsForTarget,
  getChromeMcpRoutingState,
  listChromeMcpTargetsWithLease,
  registerChromeMcpTargets,
  withChromeMcpLease,
} from "./chrome-mcp-routing.js";
import {
  chromeMcpSessions as sessions,
  retainedChromeMcpCleanupSessions as retainedCleanupSessions,
} from "./chrome-mcp-state.js";
import type { BrowserOpenResult, BrowserTab, BrowserTabOwnership } from "./client.types.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

export async function ensureChromeMcpAvailable(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<void> {
  await withChromeMcpLease(profileName, profileOptions, options, async () => {});
}

/** Return the cached Chrome MCP process pid for a profile, when present. */
export function getChromeMcpPid(profileName: string): number | null {
  for (const [key, session] of sessions.entries()) {
    if (cacheKeyMatchesProfileName(key, profileName)) {
      return session.transport.pid ?? null;
    }
  }
  for (const [key, retained] of retainedCleanupSessions) {
    if (cacheKeyMatchesProfileName(key, profileName)) {
      const session = retained.values().next().value;
      const target = session?.processCleanup ? cleanupTarget(session.processCleanup) : undefined;
      return target?.root.pid ?? session?.transport.pid ?? null;
    }
  }
  return null;
}

/** Close every cached Chrome MCP session. */
async function readChromeMcpTabs(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<BrowserTab[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withChromeMcpLease(
        profileName,
        profileOptions,
        options,
        async (lease, normalizedProfileOptions) =>
          (
            await listChromeMcpTargetsWithLease({
              profileName,
              profileOptions: normalizedProfileOptions,
              lease,
              options,
            })
          ).map(({ page, targetId }) => ({
            targetId,
            title: "",
            url: page.url ?? "",
            type: "page",
          })),
      );
    } catch (err) {
      if (err instanceof ChromeMcpReconnectRequiredError && attempt === 0) {
        continue;
      }
      throw err;
    }
  }
  return [];
}

/** List Chrome MCP pages converted to persistent BrowserTab handles. */
export async function listChromeMcpTabs(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpOperationOptions = {},
): Promise<BrowserTab[]> {
  return await readChromeMcpTabs(profileName, profileOptions, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

/** Count Chrome MCP pages without returning handles from an ephemeral session. */
export async function countChromeMcpTabs(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<number> {
  return (await readChromeMcpTabs(profileName, profileOptions, options)).length;
}

async function lookupChromeMcpMarkerNativeTarget(params: {
  browserUrl: string;
  markerUrl: string;
  options: ChromeMcpOpenOptions;
}): Promise<string | undefined> {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(params.browserUrl);
  const rawTargets = await fetchJson<unknown>(
    appendCdpPath(cdpHttpBase, "/json/list"),
    params.options.cdpTimeouts?.httpTimeoutMs,
    { signal: params.options.signal },
    params.options.cdpPolicy,
  );
  if (!Array.isArray(rawTargets)) {
    throw new Error("CDP target list response was not an array");
  }
  if (rawTargets.some((target) => !target || typeof target !== "object")) {
    throw new Error("CDP target list response contained a malformed entry");
  }
  const targets = rawTargets as Array<{ id?: unknown; url?: unknown; type?: unknown }>;
  const matches = targets.filter(
    (target) =>
      target.url === params.markerUrl &&
      typeof target.id === "string" &&
      target.id.trim() &&
      (target.type === undefined || target.type === "page"),
  );
  if (matches.length !== 1) {
    return undefined;
  }
  const nativeTargetId = matches[0]?.id;
  return typeof nativeTargetId === "string" ? nativeTargetId.trim() || undefined : undefined;
}

async function captureChromeMcpTabOwnership(params: {
  profileName: string;
  browserUrl: string | undefined;
  markerUrl: string | undefined;
  options: ChromeMcpOpenOptions;
}): Promise<{ ownership: BrowserTabOwnership; nativeTargetId?: string }> {
  if (!params.browserUrl || !params.markerUrl) {
    return { ownership: { status: "non-durable", reason: "explicit-cdp-url-required" } };
  }
  let nativeTargetId: string | undefined;
  try {
    nativeTargetId = await lookupChromeMcpMarkerNativeTarget({
      browserUrl: params.browserUrl,
      markerUrl: params.markerUrl,
      options: params.options,
    });
  } catch (error) {
    if (params.options.signal?.aborted) {
      throw params.options.signal.reason ?? error;
    }
    if (error instanceof BrowserCdpEndpointBlockedError) {
      throw error;
    }
    return { ownership: { status: "non-durable", reason: "target-marker-lookup-failed" } };
  }
  if (!nativeTargetId) {
    return { ownership: { status: "non-durable", reason: "target-marker-not-unique" } };
  }
  const ownership = await resolveCdpTabOwnership({
    profileName: params.profileName,
    cdpUrl: params.browserUrl,
    nativeTargetId,
    timeoutMs: params.options.cdpTimeouts?.httpTimeoutMs,
    signal: params.options.signal,
    ssrfPolicy: params.options.cdpPolicy,
  });
  return { ownership, nativeTargetId };
}

/** Open a new Chrome MCP tab and navigate it to the requested URL. */
export async function openChromeMcpTab(
  profileName: string,
  url: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpOpenOptions = {},
): Promise<BrowserOpenResult> {
  const targetUrl = url.trim() || "about:blank";
  return await withChromeMcpLease(
    profileName,
    profileOptions,
    options,
    async (lease, normalizedProfileOptions) => {
      const existingPages = await listChromeMcpTargetsWithLease({
        profileName,
        profileOptions: normalizedProfileOptions,
        lease,
        options: { timeoutMs: CHROME_MCP_NEW_PAGE_TIMEOUT_MS, signal: options.signal },
      });
      const canUseMcpCompensation = existingPages.length > 0;
      if (!canUseMcpCompensation && !normalizedProfileOptions.browserUrl) {
        throw new Error(
          "Chrome MCP cannot safely open the first page without an explicit CDP endpoint.",
        );
      }
      const markerUrl = normalizedProfileOptions.browserUrl
        ? `about:blank#openclaw-${randomUUID()}`
        : undefined;
      const initialUrl = markerUrl ?? "about:blank";
      const result = await callTool(
        profileName,
        normalizedProfileOptions,
        "new_page",
        { url: initialUrl, timeout: CHROME_MCP_NEW_PAGE_TIMEOUT_MS },
        options,
        lease,
      );
      // new_page may return only its created page. Merge that partial response;
      // only list_pages may prune unrelated live target and ref mappings.
      const createdPages = registerChromeMcpTargets(lease.session, extractStructuredPages(result), {
        authoritative: false,
      });
      const created = createdPages.find(({ page }) => page.selected) ?? createdPages.at(-1);
      if (!created) {
        throw new Error("Chrome MCP did not return the created page.");
      }
      let capturedNativeTargetId: string | undefined;
      const closeUntrackedPage = async () => {
        // Page creation already succeeded, so cleanup must not reuse an aborted
        // caller signal that would leave the marker page untracked.
        let directCloseError: unknown;
        if (normalizedProfileOptions.browserUrl && markerUrl) {
          try {
            const nativeTargetId =
              capturedNativeTargetId ??
              (await lookupChromeMcpMarkerNativeTarget({
                browserUrl: normalizedProfileOptions.browserUrl,
                markerUrl,
                options: { ...options, signal: undefined },
              }));
            if (nativeTargetId) {
              const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(
                normalizedProfileOptions.browserUrl,
              );
              await fetchOk(
                appendCdpPath(cdpHttpBase, `/json/close/${encodeURIComponent(nativeTargetId)}`),
                options.cdpTimeouts?.httpTimeoutMs,
                undefined,
                options.cdpPolicy,
              );
              const routing = getChromeMcpRoutingState(lease.session);
              routing.targetIdByPageId.delete(created.page.id);
              clearChromeMcpSnapshotRefsForTarget(routing, created.targetId);
              return;
            }
          } catch (error) {
            directCloseError = error;
          }
        }
        if (!canUseMcpCompensation) {
          throw directCloseError instanceof Error
            ? directCloseError
            : new Error("Could not resolve the created Chrome MCP target", {
                cause: directCloseError,
              });
        }
        await callTool(
          profileName,
          normalizedProfileOptions,
          "close_page",
          { pageId: created.page.id },
          { timeoutMs: CHROME_MCP_NEW_PAGE_TIMEOUT_MS },
          lease,
        );
        const routing = getChromeMcpRoutingState(lease.session);
        routing.targetIdByPageId.delete(created.page.id);
        clearChromeMcpSnapshotRefsForTarget(routing, created.targetId);
      };
      try {
        const captured = await captureChromeMcpTabOwnership({
          profileName,
          browserUrl: normalizedProfileOptions.browserUrl,
          markerUrl,
          options,
        });
        capturedNativeTargetId = captured.nativeTargetId;
        if (!canUseMcpCompensation && captured.ownership.status !== "durable") {
          throw new Error(
            "Chrome MCP cannot safely track the first page without durable CDP ownership.",
          );
        }
        if (targetUrl === initialUrl) {
          return {
            targetId: created.targetId,
            title: "",
            url: created.page.url ?? targetUrl,
            type: "page",
            ownership: captured.ownership,
          };
        }
        const navigateCallTimeoutMs = resolveChromeMcpNavigateCallTimeoutMs(
          CHROME_MCP_NAVIGATE_TIMEOUT_MS,
        );
        await callTool(
          profileName,
          normalizedProfileOptions,
          "navigate_page",
          {
            pageId: created.page.id,
            type: "url",
            url: targetUrl,
            timeout: CHROME_MCP_NAVIGATE_TIMEOUT_MS,
          },
          { timeoutMs: navigateCallTimeoutMs, signal: options.signal },
          lease,
        );
        const verified = await listChromeMcpTargetsWithLease({
          profileName,
          profileOptions: normalizedProfileOptions,
          lease,
          options: { timeoutMs: navigateCallTimeoutMs, signal: options.signal },
        });
        const finalPage = verified.find((entry) => entry.targetId === created.targetId);
        if (!finalPage) {
          throw new Error("Chrome MCP created page identity changed before navigation completed.");
        }
        return {
          targetId: created.targetId,
          title: "",
          url: finalPage.page.url ?? targetUrl,
          type: "page",
          ownership: captured.ownership,
        };
      } catch (openError) {
        try {
          await closeUntrackedPage();
        } catch (closeError) {
          throw Object.assign(
            new Error("Failed to open a tracked Chrome MCP page and close its marker", {
              cause: openError,
            }),
            { errors: [openError, closeError] },
          );
        }
        throw openError;
      }
    },
  );
}

/** Bring a Chrome MCP page to the foreground. */
