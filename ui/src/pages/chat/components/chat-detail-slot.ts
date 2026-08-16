import { html, type TemplateResult } from "lit";
import type { ChatPageHost } from "../chat-state-host.ts";
import type { ChatProps } from "../chat-view.ts";
import { openSlot, type SidebarLayout } from "../sidebar-layout.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import "./chat-sidebar.ts";
import { openSessionWorkspaceFile, revealSessionWorkspaceFile } from "./chat-session-workspace.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar.ts";
import { resetTaskDetail } from "./chat-task-detail-state.ts";
import { renderTaskDetailPanel } from "./chat-task-detail.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

// Region close collapses the detail slot but leaves sidebarContent set, so
// "task content exists" is not "panel visible"; consumers (panel render, rail
// open-row highlight) must gate on the layout, not the content.
export function detailSlotOpen(layout: SidebarLayout): boolean {
  return layout.columns.some((column) => column.panels.some((panel) => panel.slot === "detail"));
}

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
  if (content.kind === "task") {
    if (!detailSlotOpen(params.layout)) {
      resetTaskDetail(host);
      return html``;
    }
    return renderTaskDetailPanel({
      backgroundTasks: params.backgroundTasks,
      chat: params.chat,
      host,
      task: params.backgroundTasks.tasks?.find((task) => task.id === content.taskId) ?? undefined,
      transcript: params.transcript,
    });
  }
  resetTaskDetail(host);
  return html`<openclaw-chat-detail-panel
    class="chat-sidebar"
    .content=${content}
    .loadFullMessage=${params.fullMessageLoader}
    .canvasPluginSurfaceUrl=${host.canvasPluginSurfaceUrl}
    .embedSandboxMode=${host.embedSandboxMode}
    .allowExternalEmbedUrls=${host.allowExternalEmbedUrls}
    .onOpenWorkspaceFile=${(target: { path: string; line?: number | null }) =>
      openSessionWorkspaceFile(host, target)}
    .onRevealInWorkspace=${(path: string) => {
      revealSessionWorkspaceFile(host, path);
      host.updateSidebarLayout(openSlot(host.sidebarLayout, "workspace"));
    }}
    .onOpenImage=${(item: Parameters<typeof host.handleOpenImage>[0]) =>
      host.handleOpenImage(item, host.beginImageOpen())}
    .embedded=${true}
    @chat-detail-panel-close=${() => host.handleCloseSidebar()}
  ></openclaw-chat-detail-panel>`;
}
