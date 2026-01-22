import type { ClawdbotConfig, RuntimeEnv } from "clawdbot/plugin-sdk";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import {
  buildFileInfoCard,
  parseFileConsentInvoke,
  uploadToConsentUrl,
} from "./file-consent.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { getPendingUpload, removePendingUpload } from "./pending-uploads.js";
import type { MSTeamsPollStore } from "./polls.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export type MSTeamsAccessTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

export type MSTeamsActivityHandler = {
  onMessage: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onMembersAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  run?: (context: unknown) => Promise<void>;
};

export type MSTeamsMessageHandlerDeps = {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  appId: string;
  adapter: MSTeamsAdapter;
  tokenProvider: MSTeamsAccessTokenProvider;
  textLimit: number;
  mediaMaxBytes: number;
  conversationStore: MSTeamsConversationStore;
  pollStore: MSTeamsPollStore;
  log: MSTeamsMonitorLogger;
};

/**
 * Handle fileConsent/invoke activities for large file uploads.
 */
async function handleFileConsentInvoke(
  context: MSTeamsTurnContext,
  log: MSTeamsMonitorLogger,
): Promise<boolean> {
  const activity = context.activity;
  if (activity.type !== "invoke" || activity.name !== "fileConsent/invoke") {
    return false;
  }

  const consentResponse = parseFileConsentInvoke(activity);
  if (!consentResponse) {
    log.debug("invalid file consent invoke", { value: activity.value });
    return false;
  }

  const uploadId =
    typeof consentResponse.context?.uploadId === "string"
      ? consentResponse.context.uploadId
      : undefined;

  if (consentResponse.action === "accept" && consentResponse.uploadInfo) {
    const pendingFile = getPendingUpload(uploadId);
    if (pendingFile) {
      log.debug("user accepted file consent, uploading", {
        uploadId,
        filename: pendingFile.filename,
        size: pendingFile.buffer.length,
      });

      try {
        // Upload file to the provided URL
        await uploadToConsentUrl({
          url: consentResponse.uploadInfo.uploadUrl,
          buffer: pendingFile.buffer,
          contentType: pendingFile.contentType,
        });

        // Send confirmation card
        const fileInfoCard = buildFileInfoCard({
          filename: consentResponse.uploadInfo.name,
          contentUrl: consentResponse.uploadInfo.contentUrl,
          uniqueId: consentResponse.uploadInfo.uniqueId,
          fileType: consentResponse.uploadInfo.fileType,
        });

        await context.sendActivity({
          type: "message",
          attachments: [fileInfoCard],
        });

        log.info("file upload complete", {
          uploadId,
          filename: consentResponse.uploadInfo.name,
          uniqueId: consentResponse.uploadInfo.uniqueId,
        });
      } catch (err) {
        log.debug("file upload failed", { uploadId, error: String(err) });
        await context.sendActivity(`File upload failed: ${String(err)}`);
      } finally {
        removePendingUpload(uploadId);
      }
    } else {
      log.debug("pending file not found for consent", { uploadId });
      await context.sendActivity(
        "The file upload request has expired. Please try sending the file again.",
      );
    }
  } else {
    // User declined
    log.debug("user declined file consent", { uploadId });
    removePendingUpload(uploadId);
  }

  return true;
}

export function registerMSTeamsHandlers<T extends MSTeamsActivityHandler>(
  handler: T,
  deps: MSTeamsMessageHandlerDeps,
): T {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);

  // Wrap the original run method to intercept invokes
  const originalRun = handler.run;
  if (originalRun) {
    handler.run = async (context: unknown) => {
      const ctx = context as MSTeamsTurnContext;
      // Handle file consent invokes before passing to normal flow
      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "fileConsent/invoke") {
        const handled = await handleFileConsentInvoke(ctx, deps.log);
        if (handled) {
          // Send invoke response for file consent
          await ctx.sendActivity({ type: "invokeResponse", value: { status: 200 } });
          return;
        }
      }
      return originalRun.call(handler, context);
    };
  }

  handler.onMessage(async (context, next) => {
    try {
      await handleTeamsMessage(context as MSTeamsTurnContext);
    } catch (err) {
      deps.runtime.error?.(`msteams handler failed: ${String(err)}`);
    }
    await next();
  });

  handler.onMembersAdded(async (context, next) => {
    const membersAdded = (context as MSTeamsTurnContext).activity?.membersAdded ?? [];
    for (const member of membersAdded) {
      if (member.id !== (context as MSTeamsTurnContext).activity?.recipient?.id) {
        deps.log.debug("member added", { member: member.id });
        // Don't send welcome message - let the user initiate conversation.
      }
    }
    await next();
  });

  return handler;
}
