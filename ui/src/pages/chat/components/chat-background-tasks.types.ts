import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import type { SubagentActivityPresentation } from "./chat-subagent-activity.ts";

export type BackgroundTasksProps = {
  sessionKey: string;
  statusRowId: string;
  collapsed: boolean;
  /** Narrow panes move the rail to a bottom strip. */
  narrowLayout: boolean;
  connected: boolean;
  canCancel: boolean;
  loading: boolean;
  error: string | null;
  tasks: TaskSummary[] | null;
  activeCount: number;
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
