import { html, type TemplateResult } from "lit";
import type { ChatPageHost } from "../chat-state-host.ts";
import type { ChatProps } from "../chat-view.ts";
import type { SidebarLayout } from "../sidebar-layout.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import "./chat-sidebar.ts";
import { openSessionWorkspaceFile, revealSessionWorkspaceFile } from "./chat-session-workspace.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar.ts";
import { resetSubagentDetail } from "./chat-subagent-detail-state.ts";
import { renderSubagentDetailPanel } from "./chat-subagent-detail.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

export function renderChatDetailSlot(params: {
  backgroundTasks: BackgroundTasksProps;
  chat: ChatProps;
  content: SidebarContent;
  fullMessageLoader: SidebarFullMessageLoader | null;
  host: ChatPageHost;
  layout: SidebarLayout;
  transcript: ChatTranscriptController;
}): TemplateResult {
  const { content, host } = params;
  if (content.kind === "subagent") {
    const detailOpen = params.layout.columns.some((column) =>
      column.panels.some((panel) => panel.slot === "detail"),
    );
    if (!detailOpen) {
      resetSubagentDetail(host);
      return html``;
    }
    return renderSubagentDetailPanel({
      backgroundTasks: params.backgroundTasks,
      chat: params.chat,
      host,
      task: params.backgroundTasks.tasks?.find((task) => task.id === content.taskId) ?? undefined,
      transcript: params.transcript,
    });
  }
  resetSubagentDetail(host);
  return html`<openclaw-chat-detail-panel
    class="chat-sidebar"
    .content=${content}
    .loadFullMessage=${params.fullMessageLoader}
    .canvasPluginSurfaceUrl=${host.canvasPluginSurfaceUrl}
    .embedSandboxMode=${host.embedSandboxMode}
    .allowExternalEmbedUrls=${host.allowExternalEmbedUrls}
    .onOpenWorkspaceFile=${(target: { path: string; line?: number | null }) =>
      openSessionWorkspaceFile(host, target)}
    .onRevealInWorkspace=${(path: string) => revealSessionWorkspaceFile(host, path)}
    .onOpenImage=${(item: Parameters<typeof host.handleOpenImage>[0]) =>
      host.handleOpenImage(item, host.beginImageOpen())}
    .embedded=${true}
    @chat-detail-panel-close=${() => host.handleCloseSidebar()}
  ></openclaw-chat-detail-panel>`;
}
