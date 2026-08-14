import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import type { SubagentActivityPresentation } from "./chat-subagent-activity.ts";

export type BackgroundTasksProps = {
  sessionKey: string;
  statusRowId: string;
  collapsed: boolean;
  /** Pane too narrow for a side rail: presentation moves to a bottom strip
   * (mirrors the workspace rail's narrow mode). */
  narrowLayout: boolean;
  connected: boolean;
  canCancel: boolean;
  loading: boolean;
  error: string | null;
  /** null until the first load for this session finished. */
  tasks: TaskSummary[] | null;
  subagentActivity: SubagentActivityPresentation;
  openTaskId?: string;
  taskDetails: ReadonlyMap<string, TaskSummary>;
  taskDetailErrors: ReadonlyMap<string, string>;
  taskDetailLoadingIds: ReadonlySet<string>;
  cancellingTaskIds: ReadonlySet<string>;
  finishedCollapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleFinished: () => void;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
  onLoadDetail?: (task: TaskSummary) => void;
  onOpenTaskDetail?: (task: TaskSummary) => void;
};
