import { html, type TemplateResult } from "lit";
import type { ChatPageHost } from "../chat-state-host.ts";
import { selectedChatSessionRow } from "../chat-state-route.ts";
import type { ChatProps } from "../chat-view.ts";
import { openSlot, type SidebarLayout } from "../sidebar-layout.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import "./chat-sidebar.ts";
import { openSessionWorkspaceFile, revealSessionWorkspaceFile } from "./chat-session-workspace.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { resetTaskDetail, type TaskDetailHost } from "./chat-task-detail-state.ts";
import { renderTaskDetailPanel } from "./chat-task-detail.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

// Region close collapses the detail slot but leaves sidebarContent set, so
// "task content exists" is not "panel visible"; consumers (panel render, rail
// open-row highlight) must gate on the layout, not the content.
function detailSlotOpen(layout: SidebarLayout): boolean {
  return layout.columns.some((column) => column.panels.some((panel) => panel.slot === "detail"));
}

export function openTaskDetailId(
  content: SidebarContent | null | undefined,
  layout: SidebarLayout,
): string | undefined {
  return content?.kind === "task" && detailSlotOpen(layout) ? content.taskId : undefined;
}

export function renderChatDetailSlot(params: {
  backgroundTasks: BackgroundTasksProps;
  chat: ChatProps;
  content: SidebarContent;
  host: ChatPageHost;
  layout: SidebarLayout;
  transcript: ChatTranscriptController;
}): TemplateResult {
  const { content, host } = params;
  const taskDetailHost: TaskDetailHost = host;
  const taskId = openTaskDetailId(content, params.layout);
  if (taskId === undefined && taskDetailHost.taskDetailState !== undefined) {
    resetTaskDetail(taskDetailHost);
  }
  const documents: Partial<Record<SidebarContent["kind"], TemplateResult>> = {
    task:
      taskId === undefined
        ? html``
        : renderTaskDetailPanel({
            backgroundTasks: params.backgroundTasks,
            chat: params.chat,
            host,
            task: params.backgroundTasks.tasks?.find((task) => task.id === taskId) ?? undefined,
            transcript: params.transcript,
          }),
  };
  return (
    documents[content.kind] ??
    html`<openclaw-chat-detail-panel
      class="chat-sidebar"
      .content=${content}
      .execNode=${selectedChatSessionRow(host)?.execNode ?? null}
      .attachmentRuntime=${{
        authToken: params.chat.assistantAttachmentAuthToken,
        connectionEpoch: params.chat.connectionEpoch,
        localMediaPreviewRoots: params.chat.localMediaPreviewRoots ?? [],
        resourceBasePath: params.chat.resourceBasePath,
        resolveArtifactDownload: params.chat.resolveArtifactDownload,
      }}
      .basePath=${params.chat.basePath ?? ""}
      .canvasPluginSurfaceUrl=${host.canvasPluginSurfaceUrl}
      .embedSandboxMode=${host.embedSandboxMode}
      .allowExternalEmbedUrls=${host.allowExternalEmbedUrls}
      .onOpenWorkspaceFile=${(target: { path: string; line?: number | null }) =>
        openSessionWorkspaceFile(host, target)}
      .onOpenSessionLink=${params.chat.onOpenSessionLink}
      .onRevealInWorkspace=${(path: string) => {
        revealSessionWorkspaceFile(host, path);
        host.updateSidebarLayout(openSlot(host.sidebarLayout, "workspace"));
      }}
      .onOpenImage=${(item: Parameters<typeof host.handleOpenImage>[0]) =>
        host.handleOpenImage(item, host.beginImageOpen())}
      .embedded=${true}
      @chat-detail-panel-close=${() =>
        host.handleCloseSidebar(content.kind === "attachment" ? "workspace" : "detail")}
    ></openclaw-chat-detail-panel>`
  );
}
