import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { respondToMSTeamsFileConsentInvoke } from "./file-consent-invoke.js";
import { getPendingUploadFs, storePendingUploadFs } from "./pending-uploads-fs.js";
import { clearPendingUploads, getPendingUpload, storePendingUpload } from "./pending-uploads.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const fileConsentMockState = vi.hoisted(() => ({
  uploadToConsentUrl: vi.fn(),
}));

vi.mock("./monitor-handler/message-handler.js", () => ({
  createMSTeamsMessageHandler: () => async () => {},
}));

vi.mock("./monitor-handler/reaction-handler.js", () => ({
  createMSTeamsReactionHandler: () => async () => {},
}));

vi.mock("./file-consent.js", async () => {
  const actual = await vi.importActual<typeof import("./file-consent.js")>("./file-consent.js");
  return {
    ...actual,
    uploadToConsentUrl: fileConsentMockState.uploadToConsentUrl,
  };
});

function createRuntimeStub(stateDir?: string): PluginRuntime {
  return {
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: () => ({
          enqueue: async () => {},
        }),
      },
    },
    state: {
      resolveStateDir: (env?: NodeJS.ProcessEnv) => {
        const override = env?.OPENCLAW_STATE_DIR?.trim();
        if (override) {
          return override;
        }
        return stateDir ?? path.join(os.homedir(), ".openclaw");
      },
    },
  } as unknown as PluginRuntime;
}

const runtimeStub: PluginRuntime = createRuntimeStub();

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
};

function createInvokeContext(params: {
  conversationId: string;
  uploadId: string;
  action: "accept" | "decline";
}): {
  context: MSTeamsTurnContext;
  sendActivity: ReturnType<typeof vi.fn>;
  updateActivity: ReturnType<typeof vi.fn>;
} {
  const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
  const updateActivity = vi.fn(async () => ({ id: "activity-id" }));
  const uploadInfo =
    params.action === "accept"
      ? {
          name: "secret.txt",
          uploadUrl: "https://upload.example.com/put",
          contentUrl: "https://content.example.com/file",
          uniqueId: "unique-id",
          fileType: "txt",
        }
      : undefined;
  return {
    context: {
      activity: {
        type: "invoke",
        name: "fileConsent/invoke",
        conversation: { id: params.conversationId },
        value: {
          type: "fileUpload",
          action: params.action,
          uploadInfo,
          context: { uploadId: params.uploadId },
        },
      },
      sendActivity,
      sendActivities: async () => [],
      updateActivity,
    } as unknown as MSTeamsTurnContext,
    sendActivity,
    updateActivity,
  };
}

function createConsentInvokeHarness(params: {
  pendingConversationId?: string;
  invokeConversationId: string;
  action: "accept" | "decline";
  consentCardActivityId?: string;
}) {
  const uploadId = storePendingUpload({
    buffer: Buffer.from("TOP_SECRET_VICTIM_FILE\n"),
    filename: "secret.txt",
    contentType: "text/plain",
    conversationId: params.pendingConversationId ?? "19:victim@thread.v2",
    consentCardActivityId: params.consentCardActivityId,
  });
  const { context, sendActivity, updateActivity } = createInvokeContext({
    conversationId: params.invokeConversationId,
    uploadId,
    action: params.action,
  });
  return { uploadId, context, sendActivity, updateActivity };
}

function requirePendingUpload(uploadId: string) {
  const upload = getPendingUpload(uploadId);
  if (!upload) {
    throw new Error(`expected pending upload ${uploadId}`);
  }
  return upload;
}

describe("msteams file consent invoke authz", () => {
  beforeEach(() => {
    setMSTeamsRuntime(runtimeStub);
    clearPendingUploads();
    vi.clearAllMocks();
    fileConsentMockState.uploadToConsentUrl.mockReset();
    fileConsentMockState.uploadToConsentUrl.mockResolvedValue(undefined);
  });

  it("uploads when invoke conversation matches pending upload conversation", async () => {
    const { uploadId, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
    });

    await respondToMSTeamsFileConsentInvoke(context, log);

    // invokeResponse should be sent immediately
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
      }),
    );

    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);

    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://upload.example.com/put",
      }),
    );
    expect(getPendingUpload(uploadId)).toBeUndefined();
  });

  it("calls updateActivity to replace the consent card when consentCardActivityId is set", async () => {
    const { context, sendActivity, updateActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      consentCardActivityId: "consent-card-activity-id-123",
    });

    await respondToMSTeamsFileConsentInvoke(context, log);

    expect(sendActivity).toHaveBeenCalledWith(expect.objectContaining({ type: "invokeResponse" }));
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);

    // Should replace the original consent card with the file info card
    expect(updateActivity).toHaveBeenCalledTimes(1);
    expect(updateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "consent-card-activity-id-123",
        type: "message",
        attachments: expect.arrayContaining([
          expect.objectContaining({
            contentType: "application/vnd.microsoft.teams.card.file.info",
          }),
        ]),
      }),
    );
  });

  it("does not send file info card via sendActivity when updateActivity succeeds", async () => {
    const { context, sendActivity, updateActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      consentCardActivityId: "consent-card-activity-id-happy",
    });

    await respondToMSTeamsFileConsentInvoke(context, log);

    // updateActivity should replace the consent card in-place
    expect(updateActivity).toHaveBeenCalledTimes(1);

    // sendActivity should only be called once for the invokeResponse, NOT for the file info card
    expect(sendActivity).toHaveBeenCalledTimes(1);
    expect(sendActivity).toHaveBeenCalledWith(expect.objectContaining({ type: "invokeResponse" }));

    // Explicitly verify no file info card was sent via sendActivity
    for (const call of sendActivity.mock.calls) {
      const arg = call[0] as Record<string, unknown>;
      if (typeof arg === "object" && arg !== null && "attachments" in arg) {
        const attachments = arg.attachments as Array<{ contentType?: string }>;
        for (const att of attachments) {
          expect(att.contentType).not.toBe("application/vnd.microsoft.teams.card.file.info");
        }
      }
    }
  });

  it("does not call updateActivity when no consentCardActivityId is stored", async () => {
    const { context, updateActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      // no consentCardActivityId
    });

    await respondToMSTeamsFileConsentInvoke(context, log);

    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
    expect(updateActivity).not.toHaveBeenCalled();
  });

  it("still completes upload if updateActivity throws", async () => {
    const { uploadId, context, updateActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:victim@thread.v2;messageid=abc123",
      action: "accept",
      consentCardActivityId: "consent-card-activity-id-fail",
    });
    updateActivity.mockRejectedValueOnce(new Error("Teams API error"));

    await respondToMSTeamsFileConsentInvoke(context, log);

    // Upload should have completed despite updateActivity failure
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
    expect(getPendingUpload(uploadId)).toBeUndefined();
    expect(updateActivity).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-conversation accept invoke and keeps pending upload", async () => {
    const { uploadId, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:attacker@thread.v2",
      action: "accept",
    });

    await respondToMSTeamsFileConsentInvoke(context, log);

    // invokeResponse should be sent immediately
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
      }),
    );

    expect(sendActivity).toHaveBeenCalledWith(
      "The file upload request has expired. Please try sending the file again.",
    );

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(requirePendingUpload(uploadId)).toMatchObject({
      conversationId: "19:victim@thread.v2",
      filename: "secret.txt",
      contentType: "text/plain",
    });
  });

  it("ignores cross-conversation decline invoke and keeps pending upload", async () => {
    const { uploadId, context, sendActivity } = createConsentInvokeHarness({
      invokeConversationId: "19:attacker@thread.v2",
      action: "decline",
    });

    await respondToMSTeamsFileConsentInvoke(context, log);

    // invokeResponse should be sent immediately
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
      }),
    );

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(requirePendingUpload(uploadId)).toMatchObject({
      conversationId: "19:victim@thread.v2",
      filename: "secret.txt",
      contentType: "text/plain",
    });
    expect(sendActivity).toHaveBeenCalledTimes(1);
  });
});

describe("msteams file consent invoke FS fallback", () => {
  let tmpDir: string;
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    originalStateDir = process.env.OPENCLAW_STATE_DIR;
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-invoke-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    setMSTeamsRuntime(createRuntimeStub(tmpDir));
    clearPendingUploads();
    vi.clearAllMocks();
    fileConsentMockState.uploadToConsentUrl.mockReset();
    fileConsentMockState.uploadToConsentUrl.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // tmp dir may already be gone
    }
  });

  it("reads pending upload from FS store when in-memory store is empty (cross-process CLI path)", async () => {
    // Simulate the CLI process writing to the FS store before exiting; the
    // in-memory store in this (monitor) process is empty.
    const uploadId = "cli-upload-id-123";
    const conversationId = "19:victim@thread.v2";
    await storePendingUploadFs({
      id: uploadId,
      buffer: Buffer.from("CLI PAYLOAD"),
      filename: "cli.bin",
      contentType: "application/octet-stream",
      conversationId,
    });

    expect(getPendingUpload(uploadId)).toBeUndefined();

    const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
    const updateActivity = vi.fn(async () => ({ id: "activity-id" }));
    const context = {
      activity: {
        type: "invoke",
        name: "fileConsent/invoke",
        conversation: { id: `${conversationId};messageid=abc123` },
        value: {
          type: "fileUpload",
          action: "accept",
          uploadInfo: {
            name: "cli.bin",
            uploadUrl: "https://upload.example.com/put",
            contentUrl: "https://content.example.com/cli.bin",
            uniqueId: "unique-cli",
            fileType: "bin",
          },
          context: { uploadId },
        },
      },
      sendActivity,
      sendActivities: async () => [],
      updateActivity,
    } as unknown as MSTeamsTurnContext;

    await respondToMSTeamsFileConsentInvoke(context, log);

    // The upload should have run using the FS-loaded buffer
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledTimes(1);
    expect(fileConsentMockState.uploadToConsentUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://upload.example.com/put",
      }),
    );

    // FS entry should have been cleaned up after successful upload
    expect(await getPendingUploadFs(uploadId)).toBeUndefined();
  });

  it("cleans up FS entry on decline even when in-memory store is empty", async () => {
    const uploadId = "cli-decline-id";
    const conversationId = "19:victim@thread.v2";
    await storePendingUploadFs({
      id: uploadId,
      buffer: Buffer.from("DECLINED"),
      filename: "decline.txt",
      contentType: "text/plain",
      conversationId,
    });

    const sendActivity = vi.fn(async () => ({ id: "activity-id" }));
    const updateActivity = vi.fn(async () => ({ id: "activity-id" }));
    const context = {
      activity: {
        type: "invoke",
        name: "fileConsent/invoke",
        conversation: { id: `${conversationId};messageid=abc123` },
        value: {
          type: "fileUpload",
          action: "decline",
          context: { uploadId },
        },
      },
      sendActivity,
      sendActivities: async () => [],
      updateActivity,
    } as unknown as MSTeamsTurnContext;

    await respondToMSTeamsFileConsentInvoke(context, log);

    expect(fileConsentMockState.uploadToConsentUrl).not.toHaveBeenCalled();
    expect(await getPendingUploadFs(uploadId)).toBeUndefined();
  });
});
