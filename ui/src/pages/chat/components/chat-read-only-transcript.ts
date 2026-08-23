import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

export function renderReadOnlyTranscript(params: {
  chat: ChatThreadProps;
  messages: unknown[];
  paneId: string;
  sessionKey: string;
  transcript: ChatTranscriptController;
}) {
  const { chat } = params;
  return renderChatThread(
    {
      paneId: params.paneId,
      sessionKey: params.sessionKey,
      announceTranscript: false,
      loading: false,
      messages: params.messages,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      runId: null,
      queue: [],
      showThinking: chat.showThinking,
      showToolCalls: chat.showToolCalls,
      persistCommentary: chat.persistCommentary,
      sessions: chat.sessions,
      sessionHost: chat.sessionHost,
      assistantName: chat.assistantName,
      assistantAvatar: chat.assistantAvatar,
      assistantAvatarUrl: chat.assistantAvatarUrl,
      userId: chat.userId,
      userName: chat.userName,
      userAvatar: chat.userAvatar,
      basePath: chat.basePath,
      fullMessageAgentId: chat.fullMessageAgentId,
      loadFullAssistantMessage: chat.loadFullAssistantMessage,
      localMediaPreviewRoots: chat.localMediaPreviewRoots,
      assistantAttachmentAuthToken: chat.assistantAttachmentAuthToken,
      resolveArtifactDownload: chat.resolveArtifactDownload,
      canvasPluginSurfaceUrl: chat.canvasPluginSurfaceUrl,
      embedSandboxMode: chat.embedSandboxMode,
      allowExternalEmbedUrls: chat.allowExternalEmbedUrls,
      fetchLinkFavicon: chat.fetchLinkFavicon,
      autoExpandToolCalls: chat.autoExpandToolCalls,
      onRequestUpdate: chat.onRequestUpdate ?? (() => {}),
      onDraftChange: () => undefined,
      onSend: () => undefined,
    },
    params.transcript,
  );
}
