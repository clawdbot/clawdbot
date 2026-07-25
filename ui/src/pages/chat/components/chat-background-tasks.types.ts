import type { TaskSummary } from "../../../lib/tasks/data.ts";

export type BackgroundTasksProps = {
  agentId: string;
  statusRowId: string;
  collapsed: boolean;
  /** Pane too narrow for a side rail: presentation moves to a bottom strip
   * (mirrors the workspace rail's narrow mode). */
  narrowLayout: boolean;
  connected: boolean;
  canCancel: boolean;
  loading: boolean;
  error: string | null;
  /** null until the first load for this agent finished. */
  tasks: TaskSummary[] | null;
  selectedTaskId: string | null;
  taskDetails: ReadonlyMap<string, TaskSummary>;
  taskDetailErrors: ReadonlyMap<string, string>;
  taskDetailLoadingIds: ReadonlySet<string>;
  cancellingTaskIds: ReadonlySet<string>;
  finishedCollapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleFinished: () => void;
  onRefresh: () => void;
  onCancel: (taskId: string) => void;
  onToggleTask: (task: TaskSummary) => void;
  onOpenSession: (sessionKey: string) => void;
};
