import path from "node:path";
import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import {
  stageSandboxMedia,
  type StageSandboxMediaResult,
} from "../../auto-reply/reply/stage-sandbox-media.js";
import type { MsgContext, TemplateContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext } from "../../infra/agent-events.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage, formatUncaughtError } from "../../infra/errors.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import { deleteMediaBuffer, MEDIA_MAX_BYTES } from "../../media/store.js";
import {
  MediaOffloadError,
  type OffloadedRef,
  parseMessageWithAttachments,
  resolveChatAttachmentMaxBytes,
  UnsupportedAttachmentError,
} from "../chat-attachments.js";
import { resolveGatewayModelSupportsImages } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  explicitOriginTargetsAcpSession,
  explicitOriginTargetsPluginBinding,
} from "./chat-origin-routing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { roundedChatSendTimingMs } from "./chat-server-timing.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function formatAttachmentFailureForLog(err: unknown): string {
  const primary = formatUncaughtError(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause === undefined) {
    return primary;
  }
  const causeText = formatUncaughtError(cause);
  if (!causeText || causeText === primary) {
    return primary;
  }
  return `${primary}\nCaused by: ${causeText}`;
}

function logAttachmentFailure(
  logGateway: Pick<GatewayRequestHandlerOptions["context"]["logGateway"], "error">,
  label: string,
  err: unknown,
): void {
  logGateway.error(label, {
    error: formatAttachmentFailureForLog(err),
    consoleMessage: `${label}: ${formatForLog(err)}`,
  });
}

function stripTrailingOffloadedMediaMarkers(message: string, refs: OffloadedRef[]): string {
  if (refs.length === 0) {
    return message;
  }
  const removableRefs = new Set(refs.map((ref) => ref.mediaRef));
  const lines = message.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines[lines.length - 1]?.trim() ?? "";
    const match = /^\[media attached:\s*(media:\/\/inbound\/[^\]\s]+)\]$/.exec(last);
    if (!match?.[1] || !removableRefs.delete(match[1])) {
      break;
    }
    lines.pop();
  }
  return lines.join("\n").trimEnd();
}

function isPdfOffloadedRef(ref: OffloadedRef): boolean {
  const mime = ref.mimeType.trim().toLowerCase();
  if (mime === "application/pdf" || mime.endsWith("+pdf")) {
    return true;
  }
  return path.extname(ref.path.split(/[?#]/u)[0] ?? "").toLowerCase() === ".pdf";
}

// Managed inbound PDFs can be read host-side from the media-store root, even
// for locked-down agents, so sandbox staging may safely fall back to that path.
function isManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  if (!isPdfOffloadedRef(ref)) {
    return false;
  }
  try {
    return parseInboundMediaUri(ref.mediaRef) !== null;
  } catch {
    return false;
  }
}

function shouldPassThroughManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  // Oversized managed PDFs remain host-readable. A sandbox copy only hits the
  // 5 MB staging cap without making the attachment more available.
  return ref.sizeBytes > MEDIA_MAX_BYTES && isManagedInboundPdfOffloadRef(ref);
}

// Stage media before ACK so permanent client errors stay 4xx and retryable
// staging failures stay 5xx. Managed PDFs retain their host-readable fallback.
async function prestageMediaPathOffloads(params: {
  offloadedRefs: OffloadedRef[];
  includeImageRefs?: boolean;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}): Promise<{ paths: string[]; types: string[]; workspaceDir?: string }> {
  const mediaPathRefs = params.offloadedRefs.filter(
    (ref) => params.includeImageRefs || !ref.mimeType.startsWith("image/"),
  );
  if (mediaPathRefs.length === 0) {
    return { paths: [], types: [] };
  }
  const refsByManagedPath = (refs: OffloadedRef[]) => ({
    paths: refs.map((ref) => ref.path),
    types: refs.map((ref) => ref.mimeType),
  });
  const passThroughRefs: OffloadedRef[] = [];
  const refsToStage: OffloadedRef[] = [];
  for (const ref of mediaPathRefs) {
    (shouldPassThroughManagedInboundPdfOffloadRef(ref) ? passThroughRefs : refsToStage).push(ref);
  }
  if (refsToStage.length === 0) {
    return refsByManagedPath(mediaPathRefs);
  }

  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      return refsByManagedPath(mediaPathRefs);
    }

    // The parser admits more than the sandbox can stage. Reject non-PDF files
    // in that gap as permanent 4xx instead of a retryable staging failure.
    const oversizedForSandbox = refsToStage.filter((ref) => ref.sizeBytes > MEDIA_MAX_BYTES);
    if (oversizedForSandbox.length > 0) {
      const details = oversizedForSandbox
        .map((ref) => `${ref.label} (${ref.sizeBytes} bytes)`)
        .join(", ");
      throw new UnsupportedAttachmentError(
        "non-image-too-large-for-sandbox",
        `attachments exceed sandbox staging limit (${MEDIA_MAX_BYTES} bytes): ${details}`,
      );
    }

    const stagingCtx: MsgContext = {
      MediaPath: expectDefined(refsToStage[0], "refs to stage entry at 0").path,
      MediaPaths: refsToStage.map((ref) => ref.path),
      MediaType: expectDefined(refsToStage[0], "refs to stage entry at 0").mimeType,
      MediaTypes: refsToStage.map((ref) => ref.mimeType),
    };
    let stageResult: StageSandboxMediaResult;
    try {
      stageResult = await stageSandboxMedia({
        ctx: stagingCtx,
        sessionCtx: stagingCtx as TemplateContext,
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        workspaceDir,
      });
    } catch (stageErr) {
      // Only managed inbound PDFs have a host-readable fallback. Other files
      // must fail before ACK or the agent silently loses the attachment.
      if (refsToStage.some((ref) => !isManagedInboundPdfOffloadRef(ref))) {
        throw stageErr;
      }
      return refsByManagedPath(mediaPathRefs);
    }

    // stageSandboxMedia preserves an absolute source path when no copy lands;
    // the staged map is the authoritative success signal.
    const stagedSources = stageResult.staged;
    const missing = refsToStage.filter((ref) => !stagedSources.has(ref.path));
    const unstageable = missing.filter((ref) => !isManagedInboundPdfOffloadRef(ref));
    if (unstageable.length > 0) {
      throw new Error(
        `attachment staging incomplete: ${stagedSources.size}/${refsToStage.length} paths staged into sandbox workspace (missing: ${unstageable.map((ref) => ref.path).join(", ")})`,
      );
    }
    const stagedPaths = stagingCtx.MediaPaths ?? [];
    const stagedTypes = stagingCtx.MediaTypes ?? refsToStage.map((ref) => ref.mimeType);
    // Preserve request order while mixing sandbox-relative paths with managed
    // host paths used by pass-through or fallback PDFs.
    const resolvedByRef = new Map<OffloadedRef, { path: string; mimeType: string }>();
    refsToStage.forEach((ref, index) => {
      resolvedByRef.set(ref, {
        path: stagedPaths[index] ?? ref.path,
        mimeType: stagedTypes[index] ?? ref.mimeType,
      });
    });
    for (const ref of passThroughRefs) {
      resolvedByRef.set(ref, { path: ref.path, mimeType: ref.mimeType });
    }
    const ordered = mediaPathRefs.map(
      (ref) => resolvedByRef.get(ref) ?? { path: ref.path, mimeType: ref.mimeType },
    );
    return {
      paths: ordered.map((entry) => entry.path),
      types: ordered.map((entry) => entry.mimeType),
      workspaceDir: sandbox.workspaceDir,
    };
  } catch (err) {
    await Promise.allSettled(
      params.offloadedRefs.map((ref) => deleteMediaBuffer(ref.id, "inbound")),
    );
    if (err instanceof MediaOffloadError || err instanceof UnsupportedAttachmentError) {
      throw err;
    }
    throw new MediaOffloadError(
      `[Gateway Error] Failed to stage attachments into agent workspace: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
}

/** Parse and pre-stage attachments before the caller's synchronous pre-ACK checks. */
export async function prepareChatSendAttachments(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  admission: AdmittedChatSend;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
}) {
  const { request, session, admission, respond, context } = params;
  const { inboundMessage, normalizedAttachments, explicitOrigin } = request;
  const { cfg, sessionKey, agentId, resolvedSessionModel, clientRunId } = session;
  const { chatSendTraceAttributes, cleanupAdmittedRun, lifecycleGeneration } = admission;
  let parsedMessage = inboundMessage;
  let parsedImages: Awaited<ReturnType<typeof parseMessageWithAttachments>>["images"] = [];
  let imageOrder: Awaited<ReturnType<typeof parseMessageWithAttachments>>["imageOrder"] = [];
  let offloadedRefs: OffloadedRef[] = [];
  let mediaPathOffloadPaths: string[] = [];
  let mediaPathOffloadTypes: string[] = [];
  let mediaPathOffloadWorkspaceDir: string | undefined;
  const explicitOriginTargetsPlugin = explicitOriginTargetsPluginBinding(explicitOrigin);
  let prepareAttachmentsMs: number | undefined;

  if (normalizedAttachments.length > 0) {
    const prepareAttachmentsStartedAtMs = performance.now();
    try {
      await measureDiagnosticsTimelineSpan(
        "gateway.chat_send.prepare_attachments",
        async () => {
          const supportsSessionModelImages = await resolveGatewayModelSupportsImages({
            loadGatewayModelCatalog: context.loadGatewayModelCatalog,
            provider: resolvedSessionModel.provider,
            model: resolvedSessionModel.model,
          });
          const supportsImages =
            supportsSessionModelImages ||
            explicitOriginTargetsAcpSession(explicitOrigin) ||
            explicitOriginTargetsPlugin;
          const routeImageOffloadsAsMediaPaths = !supportsImages;
          const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
            maxBytes: resolveChatAttachmentMaxBytes(cfg),
            log: context.logGateway,
            supportsImages,
            acceptNonImage: true,
          });
          parsedMessage = stripTrailingOffloadedMediaMarkers(
            parsed.message,
            routeImageOffloadsAsMediaPaths
              ? parsed.offloadedRefs.filter((ref) => ref.mimeType.startsWith("image/"))
              : [],
          );
          parsedImages = parsed.images;
          imageOrder = routeImageOffloadsAsMediaPaths ? [] : parsed.imageOrder;
          offloadedRefs = parsed.offloadedRefs;
          ({
            paths: mediaPathOffloadPaths,
            types: mediaPathOffloadTypes,
            workspaceDir: mediaPathOffloadWorkspaceDir,
          } = await prestageMediaPathOffloads({
            offloadedRefs,
            includeImageRefs: routeImageOffloadsAsMediaPaths,
            cfg,
            sessionKey,
            agentId,
          }));
        },
        {
          phase: "agent-turn",
          config: cfg,
          attributes: {
            ...chatSendTraceAttributes,
            attachmentCount: normalizedAttachments.length,
          },
        },
      );
      prepareAttachmentsMs = roundedChatSendTimingMs(
        performance.now() - prepareAttachmentsStartedAtMs,
      );
    } catch (err) {
      cleanupAdmittedRun({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      logAttachmentFailure(context.logGateway, "chat.send attachment parse/stage failed", err);
      respond(
        false,
        undefined,
        errorShape(
          err instanceof MediaOffloadError ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
          String(err),
        ),
      );
      return { ok: false as const };
    }
  }
  return {
    ok: true as const,
    value: {
      explicitOriginTargetsPlugin,
      imageOrder,
      mediaPathOffloadPaths,
      mediaPathOffloadTypes,
      mediaPathOffloadWorkspaceDir,
      offloadedRefs,
      parsedImages,
      parsedMessage,
      prepareAttachmentsMs,
    },
  };
}
