import type { AcpTurnAttachment } from "../../acp/control-plane/manager.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { FinalizedMsgContext } from "../templating.js";

let dispatchAcpMediaRuntimePromise: Promise<
  typeof import("./dispatch-acp-media.runtime.js")
> | null = null;

export function loadDispatchAcpMediaRuntime() {
  dispatchAcpMediaRuntimePromise ??= import("./dispatch-acp-media.runtime.js");
  return dispatchAcpMediaRuntimePromise;
}

export type DispatchAcpAttachmentRuntime = Pick<
  Awaited<ReturnType<typeof loadDispatchAcpMediaRuntime>>,
  | "MediaAttachmentCache"
  | "isMediaUnderstandingSkipError"
  | "normalizeAttachments"
  | "resolveMediaAttachmentLocalRoots"
>;

const ACP_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ACP_ATTACHMENT_TIMEOUT_MS = 1_000;

export async function resolveAcpAttachments(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  runtime?: DispatchAcpAttachmentRuntime;
}): Promise<AcpTurnAttachment[]> {
  const runtime = params.runtime ?? (await loadDispatchAcpMediaRuntime());
  const mediaAttachments = runtime
    .normalizeAttachments(params.ctx)
    .map((attachment) =>
      normalizeOptionalString(attachment.path) ? { ...attachment, url: undefined } : attachment,
    );
  const cache = new runtime.MediaAttachmentCache(mediaAttachments, {
    localPathRoots: runtime.resolveMediaAttachmentLocalRoots({
      cfg: params.cfg,
      ctx: params.ctx,
    }),
  });
  const results: AcpTurnAttachment[] = [];
  for (const attachment of mediaAttachments) {
    const mediaType = attachment.mime ?? "application/octet-stream";
    if (!mediaType.startsWith("image/")) {
      continue;
    }
    if (!normalizeOptionalString(attachment.path)) {
      continue;
    }
    try {
      const { buffer } = await cache.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: ACP_ATTACHMENT_MAX_BYTES,
        timeoutMs: ACP_ATTACHMENT_TIMEOUT_MS,
      });
      results.push({
        mediaType,
        data: buffer.toString("base64"),
      });
    } catch (error) {
      if (runtime.isMediaUnderstandingSkipError(error)) {
        logVerbose(`dispatch-acp: skipping attachment #${attachment.index + 1} (${error.reason})`);
      } else {
        const errorName = error instanceof Error ? error.name : typeof error;
        logVerbose(
          `dispatch-acp: failed to read attachment #${attachment.index + 1} (${errorName})`,
        );
      }
    }
  }
  return results;
}
