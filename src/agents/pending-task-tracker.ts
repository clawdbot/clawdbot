/**
 * Pending Task Tracker
 *
 * Allows DyDo to record what task is currently being worked on,
 * so that after gateway restart, context can be resumed.
 *
 * Usage:
 * ```typescript
 * import { setPendingTask, clearPendingTask } from "./pending-task-tracker.js";
 *
 * // Before starting a task
 * setPendingTask("Building clawdbot after fixing bubble summary");
 *
 * // After task completes
 * clearPendingTask();
 * ```
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PENDING_TASK_PATH = path.join(os.homedir(), ".clawdbot", "pending-task.txt");

/**
 * Record the current pending task.
 * This will be read on gateway restart to resume context.
 */
export function setPendingTask(task: string): void {
  try {
    const dir = path.dirname(PENDING_TASK_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(PENDING_TASK_PATH, task, "utf-8");
  } catch (err) {
    console.warn(`[pending-task] Failed to write: ${err}`);
  }
}

/**
 * Clear the pending task (task completed).
 */
export function clearPendingTask(): void {
  try {
    if (fs.existsSync(PENDING_TASK_PATH)) {
      fs.unlinkSync(PENDING_TASK_PATH);
    }
  } catch (err) {
    console.warn(`[pending-task] Failed to clear: ${err}`);
  }
}

/**
 * Get the current pending task (if any).
 */
export function getPendingTask(): string | null {
  try {
    if (fs.existsSync(PENDING_TASK_PATH)) {
      return fs.readFileSync(PENDING_TASK_PATH, "utf-8").trim();
    }
  } catch (err) {
    console.warn(`[pending-task] Failed to read: ${err}`);
  }
  return null;
}
