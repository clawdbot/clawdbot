import { formatUnknownError } from "./errors.js";
import { buildFileInfoCard, parseFileConsentInvoke, uploadToConsentUrl } from "./file-consent.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { getPendingUploadFs, removePendingUploadFs } from "./pending-uploads-fs.js";
import { getPendingUpload, removePendingUpload } from "./pending-uploads.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

/**
 * Handle fileConsent/invoke activities for large file uploads.
 */
async function handleMSTeamsFileConsentInvoke(
  context: MSTeamsTurnContext,
  log: MSTeamsMonitorLogger,
): Promise<boolean> {
  const expiredUploadMessage =
    "The file upload request has expired. Please try sending the file again.";
  const activity = context.activity;
  if (activity.type !== "invoke" || activity.name !== "fileConsent/invoke") {
    return false;
  }

  const consentResponse = parseFileConsentInvoke(activity);
  if (!consentResponse) {
    log.debug?.("invalid file consent invoke", { value: activity.value });
    return false;
  }

  const uploadId =
    typeof consentResponse.context?.uploadId === "string"
      ? consentResponse.context.uploadId
      : undefined;
  // Prefer the in-memory store (same-process reply path); fall back to the
  // FS-backed store so CLI `message send --media` flows work even when the
  // invoke callback is delivered to a different process.
  const inMemoryFile = getPendingUpload(uploadId);
  const fsFile = inMemoryFile ? undefined : await getPendingUploadFs(uploadId);
  const pendingFile:
    | {
        buffer: Buffer;
        filename: string;
        contentType?: string;
        conversationId: string;
        consentCardActivityId?: string;
      }
    | undefined = inMemoryFile ?? fsFile;
  if (pendingFile) {
    const pendingConversationId = normalizeMSTeamsConversationId(pendingFile.conversationId);
    const invokeConversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
    if (!invokeConversationId || pendingConversationId !== invokeConversationId) {
      log.info("file consent conversation mismatch", {
        uploadId,
        expectedConversationId: pendingConversationId,
        receivedConversationId: invokeConversationId || undefined,
      });
      if (consentResponse.action === "accept") {
        await context.sendActivity(expiredUploadMessage);
      }
      return true;
    }
  }

  if (consentResponse.action === "accept" && consentResponse.uploadInfo) {
    if (pendingFile) {
      log.debug?.("user accepted file consent, uploading", {
        uploadId,
        filename: pendingFile.filename,
        size: pendingFile.buffer.length,
      });

      try {
        await uploadToConsentUrl({
          url: consentResponse.uploadInfo.uploadUrl,
          buffer: pendingFile.buffer,
          contentType: pendingFile.contentType,
        });

        const fileInfoCard = buildFileInfoCard({
          filename: consentResponse.uploadInfo.name,
          contentUrl: consentResponse.uploadInfo.contentUrl,
          uniqueId: consentResponse.uploadInfo.uniqueId,
          fileType: consentResponse.uploadInfo.fileType,
        });

        if (!pendingFile.consentCardActivityId) {
          await context.sendActivity({
            type: "message",
            attachments: [fileInfoCard],
          });
        }

        if (pendingFile.consentCardActivityId) {
          try {
            await context.updateActivity({
              id: pendingFile.consentCardActivityId,
              type: "message",
              attachments: [fileInfoCard],
            });
          } catch {
            await context.sendActivity({
              type: "message",
              attachments: [fileInfoCard],
            });
          }
        }

        log.info("file upload complete", {
          uploadId,
          filename: consentResponse.uploadInfo.name,
          uniqueId: consentResponse.uploadInfo.uniqueId,
        });
      } catch (err) {
        log.error("file upload failed", { uploadId, error: formatUnknownError(err) });
        await context.sendActivity("File upload failed. Please try again.");
      } finally {
        removePendingUpload(uploadId);
        await removePendingUploadFs(uploadId);
      }
    } else {
      log.debug?.("pending file not found for consent", { uploadId });
      await context.sendActivity(expiredUploadMessage);
    }
  } else {
    log.debug?.("user declined file consent", { uploadId });
    removePendingUpload(uploadId);
    await removePendingUploadFs(uploadId);
  }

  return true;
}

export async function respondToMSTeamsFileConsentInvoke(
  context: MSTeamsTurnContext,
  log: MSTeamsMonitorLogger,
): Promise<void> {
  await context.sendActivity({ type: "invokeResponse", value: { status: 200 } });

  try {
    await withRevokedProxyFallback({
      run: async () => await handleMSTeamsFileConsentInvoke(context, log),
      onRevoked: async () => true,
      onRevokedLog: () => {
        log.debug?.("turn context revoked during file consent invoke; skipping delayed response");
      },
    });
  } catch (err) {
    log.debug?.("file consent handler error", { error: formatUnknownError(err) });
  }
}
