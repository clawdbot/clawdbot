/** Internal argument used by generated Windows Gateway service launchers. */
export const WINDOWS_TASK_SUPERVISOR_FLAG = "--task-supervisor";

/** Internal argument marking the Gateway child owned by the task supervisor. */
export const WINDOWS_TASK_SUPERVISOR_CHILD_FLAG = "--task-supervisor-child";

/** Private child outcome requesting replacement by the existing task supervisor. */
export const WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE = 75;
