/** Browser tool screenshot capture, private vision output, and explicit sharing hints. */
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";
import {
  browserScreenshotAction,
  describeImageFile,
  getRuntimeConfig,
  imageResultFromFile,
  jsonResult,
  readStringParam,
  readStringValue,
  resolveRuntimeImageSanitization,
  saveMediaBuffer,
  stageBrowserScreenshotForSharing,
} from "./browser-tool.runtime.js";
import { DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS } from "./browser/constants.js";
import { normalizeBrowserScreenshot } from "./browser/screenshot.js";
import { describeBrowserScreenshot, neutralizeMediaDirectives } from "./browser/vision.js";
import { wrapExternalContent } from "./sdk-security-runtime.js";

export type BrowserScreenshotOptions = {
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  activeModel?: {
    provider?: string;
    model?: string;
  };
  screenshotResultMode?: "image" | "path";
  persistScreenshot?: (params: {
    sourcePath: string;
    type: "png" | "jpeg";
    targetId?: string;
  }) => Promise<string>;
  mediaScope?: {
    sessionKey?: string;
    channel?: string;
    chatType?: string;
  };
};

function formatScreenshotShareHint(filePath: string): string {
  return `[Screenshot saved to ${JSON.stringify(filePath)}. A sanitized outbound copy is ready at this path for explicit sharing.]`;
}

const SCREENSHOT_SHARE_UNAVAILABLE =
  "[Screenshot sharing is unavailable because an outbound copy could not be prepared.]";

export async function executeScreenshotAction({
  input: params,
  baseUrl,
  profile,
  requestedTimeoutMs,
  proxyRequest,
  signal,
  onTabActivity,
  opts,
}: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  requestedTimeoutMs?: number;
  proxyRequest: BrowserProxyRequest | null;
  signal?: AbortSignal;
  onTabActivity: (targetId: string | undefined) => void;
  opts?: BrowserScreenshotOptions;
}): Promise<AgentToolResult<unknown>> {
  const targetId = readStringParam(params, "targetId");
  const fullPage = Boolean(params.fullPage);
  const ref = readStringParam(params, "ref");
  const element = readStringParam(params, "element");
  const labels = typeof params.labels === "boolean" ? params.labels : undefined;
  const type = params.type === "jpeg" ? "jpeg" : "png";
  const effectiveTimeoutMs = requestedTimeoutMs ?? DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;
  const result = proxyRequest
    ? ((await proxyRequest({
        method: "POST",
        path: "/screenshot",
        profile,
        timeoutMs: effectiveTimeoutMs,
        body: {
          targetId,
          fullPage,
          ref,
          element,
          type,
          labels,
          timeoutMs: effectiveTimeoutMs,
        },
        // SAFETY: The browser proxy preserves the /screenshot response contract used by the local client.
      })) as Awaited<ReturnType<typeof browserScreenshotAction>>)
    : await browserScreenshotAction(baseUrl, {
        targetId,
        fullPage,
        ref,
        element,
        type,
        labels,
        timeoutMs: effectiveTimeoutMs,
        profile,
        signal,
      });
  onTabActivity(readStringValue(result.targetId) ?? targetId);
  if (opts?.screenshotResultMode === "path") {
    const artifactPath = opts.persistScreenshot
      ? await opts.persistScreenshot({
          sourcePath: result.path,
          type,
          targetId: readStringValue(result.targetId) ?? targetId,
        })
      : result.path;
    if (artifactPath.length > 4_096) {
      throw new Error("Browser screenshot artifact path exceeds 4096 characters");
    }
    // SAFETY: Screenshot responses are records; optional fields are narrowed before use.
    const resultRecord = result as Record<string, unknown>;
    const resultTargetId = readStringValue(resultRecord.targetId) ?? targetId;
    const resultUrl = readStringValue(resultRecord.url);
    return jsonResult({
      ok: resultRecord.ok === true,
      path: artifactPath,
      ...(resultTargetId ? { targetId: truncateUtf16Safe(resultTargetId, 256) } : {}),
      ...(resultUrl ? { url: truncateUtf16Safe(resultUrl, 2_048) } : {}),
      ...(Array.isArray(resultRecord.annotations)
        ? { annotationCount: resultRecord.annotations.length }
        : {}),
      media: { outbound: false },
    });
  }
  const screenshotPath = result.path;
  const screenshotCfg = getRuntimeConfig();
  const imageSanitization = resolveRuntimeImageSanitization();
  let shareHint = SCREENSHOT_SHARE_UNAVAILABLE;
  try {
    // The original result remains private. Only this bounded outbound
    // copy may cross the sandbox boundary after an explicit message call.
    const sharePath = await stageBrowserScreenshotForSharing(
      screenshotPath,
      imageSanitization?.maxDimensionPx,
    );
    shareHint = formatScreenshotShareHint(sharePath);
  } catch {
    // Screenshot viewing remains useful when optional outbound staging fails.
  }
  // Screenshots stay in the tool result for agent vision, but channel
  // delivery must remain an explicit outbound-delivery action.
  const screenshotDetails = {
    // SAFETY: Preserve the screenshot response fields without changing their types or values.
    ...(result as Record<string, unknown>),
    media: { outbound: false },
  };
  try {
    const described = await describeBrowserScreenshot(
      {
        cfg: screenshotCfg,
        filePath: screenshotPath,
        agentDir: opts?.agentDir,
        agentId: opts?.agentId,
        workspaceDir: opts?.workspaceDir,
        activeModel: opts?.activeModel,
        mediaScope: opts?.mediaScope,
        imageSanitization,
      },
      {
        describeImageFile,
        normalizeBrowserScreenshot,
        saveMediaBuffer,
      },
    );
    if (described) {
      const analyzedBy =
        described.provider && described.model
          ? `${described.provider}/${described.model}`
          : "media image understanding";
      const headerLines = [`[analyzed by ${analyzedBy}]`];
      // Vision model descriptions contain web page content which is
      // untrusted external input — wrap it the same way snapshot and
      // tabs results are wrapped to mitigate prompt injection.
      const wrappedDescription = wrapExternalContent(
        neutralizeMediaDirectives(described.text.trim()),
        {
          source: "browser",
          includeWarning: true,
        },
      );
      const text = `${headerLines.join("\n")}\n${wrappedDescription}\n${shareHint}`;
      return {
        content: [{ type: "text", text }],
        details: {
          // SAFETY: Preserve the screenshot response fields without changing their types or values.
          ...(result as Record<string, unknown>),
          // Do NOT include details.media here — the vision path returns
          // a text description as the deliverable output. Exposing the raw
          // screenshot as media would cause channel delivery to auto-send
          // potentially sensitive page content. The text block carries the
          // staged outbound-copy path for an explicit outbound-delivery send.
          vision: {
            provider: described.provider,
            model: described.model,
            decision: described.decision,
          },
        },
      };
    }
  } catch (err) {
    // Fall back to returning the raw image block so the agent loop can
    // still recover. Provider/runtime errors are untrusted page input;
    // preserve their trust boundary and defang reply-media directives.
    const rawReason = err instanceof Error ? err.message : String(err);
    const reason = wrapExternalContent(neutralizeMediaDirectives(rawReason), {
      source: "browser",
      includeWarning: false,
    });
    const extraText = `[browser screenshot vision failed: ${reason}]\n${shareHint}`;
    return await imageResultFromFile({
      label: "browser:screenshot",
      path: screenshotPath,
      extraText,
      details: screenshotDetails,
      imageSanitization,
    });
  }
  return await imageResultFromFile({
    label: "browser:screenshot",
    path: screenshotPath,
    extraText: shareHint,
    details: screenshotDetails,
    imageSanitization,
  });
}
