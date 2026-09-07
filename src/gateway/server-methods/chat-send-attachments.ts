import path from "node:path";
import { performance } from "node:perf_hooks";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import {
  SANDBOX_MEDIA_MAX_BYTES,
  stageSandboxMedia,
  type StageSandboxMediaResult,
} from "../../auto-reply/reply/stage-sandbox-media.js";
import type { MsgContext, TemplateContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import { resolveChatAttachmentMaxBytes } from "../chat-attachment-policy.js";
import {
  discardPreparedInboundMedia,
  MediaOffloadError,
  type OffloadedRef,
  logAttachmentFailure,
  parseMessageWithAttachments,
  stripImageMediaMarkers,
  UnsupportedAttachmentError,
} from "../chat-attachments.js";
import { resolveGatewayModelSupportsImages } from "../session-utils.js";
import {
  explicitOriginTargetsAcpSession,
  explicitOriginTargetsPluginBinding,
} from "./chat-origin-routing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { roundedChatSendTimingMs } from "./chat-server-timing.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

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
  // Host-readable managed PDFs above the staging cap do not need a sandbox copy.
  return ref.sizeBytes > SANDBOX_MEDIA_MAX_BYTES && isManagedInboundPdfOffloadRef(ref);
}

// Stage media before ACK so permanent client errors stay 4xx and retryable
// staging failures stay 5xx. Managed PDFs retain their host-readable fallback.
async function prestageMediaPathOffloads(params: {
  offloadedRefs: OffloadedRef[];
  includeImageRefs?: boolean;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  abortSignal: AbortSignal;
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
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      return refsByManagedPath(mediaPathRefs);
    }

    // The parser admits more than the sandbox can stage. Reject non-PDF files
    // in that gap as permanent 4xx instead of a retryable staging failure.
    const oversizedForSandbox = refsToStage.filter(
      (ref) => ref.sizeBytes > SANDBOX_MEDIA_MAX_BYTES,
    );
    if (oversizedForSandbox.length > 0) {
      const details = oversizedForSandbox
        .map((ref) => `${ref.label} (${ref.sizeBytes} bytes)`)
        .join(", ");
      throw new UnsupportedAttachmentError(
        "non-image-too-large-for-sandbox",
        `attachments exceed sandbox staging limit (${SANDBOX_MEDIA_MAX_BYTES} bytes): ${details}`,
      );
    }

    const stagingCtx: MsgContext = {
      media: refsToStage.map((ref) => ({ path: ref.path, contentType: ref.mimeType })),
    };
    let stageResult: StageSandboxMediaResult;
    try {
      stageResult = await stageSandboxMedia({
        ctx: stagingCtx,
        sessionCtx: stagingCtx as TemplateContext,
        cfg: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        workspaceDir,
        abortSignal: params.abortSignal,
      });
    } catch (stageErr) {
      // Cancellation is terminal; only ordinary managed-PDF failures can use
      // the host-readable fallback. Other files must fail before ACK.
      if (
        (params.abortSignal.aborted && Object.is(stageErr, params.abortSignal.reason)) ||
        refsToStage.some((ref) => !isManagedInboundPdfOffloadRef(ref))
      ) {
        throw stageErr;
      }
      return refsByManagedPath(mediaPathRefs);
    }

    // stageSandboxMedia preserves an absolute source path when no copy lands;
    // the staged map is the authoritative success signal.
    const stagedSources = stageResult.staged;
    const missing = refsToStage.filter((_ref, index) => !stagedSources.has(index));
    const unstageable = missing.filter((ref) => !isManagedInboundPdfOffloadRef(ref));
    if (unstageable.length > 0) {
      throw new Error(
        `attachment staging incomplete: ${stagedSources.size}/${refsToStage.length} paths staged into sandbox workspace (missing: ${unstageable.map((ref) => ref.path).join(", ")})`,
      );
    }
    const stagedMedia = stagingCtx.media ?? [];
    // Preserve request order while mixing sandbox-relative paths with managed
    // host paths used by pass-through or fallback PDFs.
    const resolvedByRef = new Map<OffloadedRef, { path: string; mimeType: string }>();
    refsToStage.forEach((ref, index) => {
      resolvedByRef.set(ref, {
        path: stagedMedia[index]?.path ?? ref.path,
        mimeType: stagedMedia[index]?.contentType ?? ref.mimeType,
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
    if (
      (params.abortSignal.aborted && Object.is(err, params.abortSignal.reason)) ||
      err instanceof MediaOffloadError ||
      err instanceof UnsupportedAttachmentError
    ) {
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
  const {
    activeRunAbort,
    chatSendTraceAttributes,
    cleanupAdmittedRun,
    finishAbortedChatSend,
    lifecycleGeneration,
  } = admission;
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
          const imageSupport: { value: boolean | undefined } = {
            value:
              explicitOriginTargetsAcpSession(explicitOrigin) || explicitOriginTargetsPlugin
                ? true
                : undefined,
          };
          const resolveSupportsImages = async (): Promise<boolean> => {
            imageSupport.value ??= await resolveGatewayModelSupportsImages({
              loadGatewayModelCatalog: context.loadGatewayModelCatalog,
              loadGatewayModelCatalogSnapshot: context.loadGatewayModelCatalogSnapshot,
              agentId,
              provider: resolvedSessionModel.provider,
              model: resolvedSessionModel.model,
            });
            return imageSupport.value;
          };
          const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
            maxBytes: resolveChatAttachmentMaxBytes(cfg),
            log: context.logGateway,
            supportsImages: imageSupport.value ?? resolveSupportsImages,
            acceptNonImage: true,
          });
          // The parser owns MIME classification. An unresolved capability means no image was seen,
          // so post-processing must not trigger catalog discovery for a non-image attachment.
          const parsedSupportsImages = imageSupport.value !== false;
          parsedMessage = parsedSupportsImages
            ? parsed.message
            : stripImageMediaMarkers(parsed.message, parsed.offloadedRefs);
          parsedImages = parsed.images;
          imageOrder = parsed.imageOrder;
          offloadedRefs = parsed.offloadedRefs;
          ({
            paths: mediaPathOffloadPaths,
            types: mediaPathOffloadTypes,
            workspaceDir: mediaPathOffloadWorkspaceDir,
          } = await prestageMediaPathOffloads({
            offloadedRefs,
            includeImageRefs: !parsedSupportsImages,
            cfg,
            sessionKey,
            agentId,
            abortSignal: activeRunAbort.controller.signal,
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
      // Pass-through media still needs awaited cleanup when preparation was cancelled.
      activeRunAbort.controller.signal.throwIfAborted();
      prepareAttachmentsMs = roundedChatSendTimingMs(
        performance.now() - prepareAttachmentsStartedAtMs,
      );
    } catch (err) {
      const aborted =
        activeRunAbort.controller.signal.aborted &&
        (context.chatRunState.hasAbortMarker(clientRunId) ||
          Object.is(err, activeRunAbort.controller.signal.reason));
      // Retire failed-run cancellation before cleanup yields, but retain work
      // admission until deletion finishes so a late abort cannot replace the error.
      if (!aborted) {
        activeRunAbort.cleanup();
      }
      await discardPreparedInboundMedia(offloadedRefs);
      if (aborted) {
        finishAbortedChatSend();
        return { ok: false as const };
      }
      cleanupAdmittedRun();
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
