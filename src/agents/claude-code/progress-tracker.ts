/**
 * Progress Tracker for Claude Code Sessions
 *
 * Tracks session progress including:
 * - Phase status from project files (task_plan.md, progress.md)
 * - Runtime tracking
 * - DyDo command detection from logs
 *
 * Ported from monitor-v3/src/state/tracker.py
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Update phase status from project files.
 *
 * Checks:
 * 1. task_plan.md - "## Current Phase" section
 * 2. task_plan.md - Phase with "in_progress" status
 * 3. progress.md - Phase with "in_progress" status
 * 4. Default: "Running"
 *
 * @param workingDir - Project working directory
 * @returns Current phase status string
 */
export function getPhaseStatus(workingDir: string): string {
  // Check task_plan.md
  const taskPlanPath = path.join(workingDir, "task_plan.md");
  if (fs.existsSync(taskPlanPath)) {
    try {
      const content = fs.readFileSync(taskPlanPath, "utf8");

      // Find "## Current Phase" section
      const currentPhaseMatch = content.match(/## Current Phase\s*\n+([^\n#]+)/);
      if (currentPhaseMatch) {
        return currentPhaseMatch[1].trim();
      }

      // Fallback: find in_progress phase
      const inProgressMatch = content.match(
        /###\s+(Phase\s+\d+[^#\n]*)\n[\s\S]*?Status:\*\*\s*in_progress/i,
      );
      if (inProgressMatch) {
        return `${inProgressMatch[1].trim()} in progress`;
      }
    } catch {
      // File read error, continue to next
    }
  }

  // Check progress.md
  const progressPath = path.join(workingDir, "progress.md");
  if (fs.existsSync(progressPath)) {
    try {
      const content = fs.readFileSync(progressPath, "utf8");

      // Find in_progress phase
      const inProgressMatch = content.match(
        /###\s+(Phase\s+\d+[^#\n]*)\n[\s\S]*?Status:\*\*\s*in_progress/i,
      );
      if (inProgressMatch) {
        return `${inProgressMatch[1].trim()} in progress`;
      }
    } catch {
      // File read error
    }
  }

  // Check findings.md for current task
  const findingsPath = path.join(workingDir, "findings.md");
  if (fs.existsSync(findingsPath)) {
    try {
      const content = fs.readFileSync(findingsPath, "utf8");

      // Find current investigation
      const investigationMatch = content.match(/## Current Investigation\s*\n+([^\n#]+)/);
      if (investigationMatch) {
        return investigationMatch[1].trim();
      }
    } catch {
      // File read error
    }
  }

  return "Running";
}

/**
 * Get completed phases from project files.
 *
 * @param workingDir - Project working directory
 * @returns Array of completed phase names
 */
export function getCompletedPhases(workingDir: string): string[] {
  const completed: string[] = [];

  // Check task_plan.md
  const taskPlanPath = path.join(workingDir, "task_plan.md");
  if (fs.existsSync(taskPlanPath)) {
    try {
      const content = fs.readFileSync(taskPlanPath, "utf8");

      // Find all completed phases
      const matches = content.matchAll(
        /###\s+(Phase\s+\d+[^#\n]*)\n[\s\S]*?Status:\*\*\s*completed/gi,
      );
      for (const match of matches) {
        completed.push(match[1].trim());
      }
    } catch {
      // File read error
    }
  }

  // Check progress.md
  const progressPath = path.join(workingDir, "progress.md");
  if (fs.existsSync(progressPath)) {
    try {
      const content = fs.readFileSync(progressPath, "utf8");

      // Find all completed phases
      const matches = content.matchAll(
        /###\s+(Phase\s+\d+[^#\n]*)\n[\s\S]*?Status:\*\*\s*completed/gi,
      );
      for (const match of matches) {
        if (!completed.includes(match[1].trim())) {
          completed.push(match[1].trim());
        }
      }
    } catch {
      // File read error
    }
  }

  // Sort by phase number
  completed.sort((a, b) => {
    const numA = parseInt(a.match(/Phase\s+(\d+)/i)?.[1] ?? "999", 10);
    const numB = parseInt(b.match(/Phase\s+(\d+)/i)?.[1] ?? "999", 10);
    return numA - numB;
  });

  return completed;
}

/**
 * Format runtime as human-readable string.
 *
 * @param seconds - Runtime in seconds
 * @returns Formatted string like "0h 12m" or "1h 30m"
 */
export function formatRuntime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * Format runtime with more detail for longer sessions.
 *
 * @param seconds - Runtime in seconds
 * @returns Formatted string
 */
export function formatRuntimeDetailed(seconds: number): string {
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * Check if runtime has exceeded a limit.
 *
 * @param startTime - Session start time (Unix timestamp or Date)
 * @param limitHours - Limit in hours
 * @returns True if exceeded
 */
export function isRuntimeExceeded(startTime: number | Date, limitHours: number): boolean {
  const start = typeof startTime === "number" ? startTime : startTime.getTime();
  const elapsed = (Date.now() - start) / 1000;
  return elapsed >= limitHours * 3600;
}

/**
 * Get remaining time before limit.
 *
 * @param startTime - Session start time
 * @param limitHours - Limit in hours
 * @returns Remaining seconds (0 if exceeded)
 */
export function getRemainingTime(startTime: number | Date, limitHours: number): number {
  const start = typeof startTime === "number" ? startTime : startTime.getTime();
  const elapsed = (Date.now() - start) / 1000;
  const limit = limitHours * 3600;
  return Math.max(0, limit - elapsed);
}

/**
 * Detect task progress from files.
 *
 * Looks for common progress indicators:
 * - [ ] Todo
 * - [x] Done
 * - [~] In progress
 *
 * @param workingDir - Project working directory
 * @returns Progress info with total and completed counts
 */
export function detectTaskProgress(workingDir: string): {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
} {
  let total = 0;
  let completed = 0;
  let inProgress = 0;

  const files = ["task_plan.md", "progress.md", "TODO.md", "tasks.md"];

  for (const filename of files) {
    const filePath = path.join(workingDir, filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, "utf8");

      // Count checkboxes
      const todoMatches = content.match(/\[ \]/g);
      const doneMatches = content.match(/\[x\]/gi);
      const progressMatches = content.match(/\[~\]/g);

      if (todoMatches) total += todoMatches.length;
      if (doneMatches) {
        total += doneMatches.length;
        completed += doneMatches.length;
      }
      if (progressMatches) {
        total += progressMatches.length;
        inProgress += progressMatches.length;
      }
    } catch {
      // File read error
    }
  }

  return {
    total,
    completed,
    inProgress,
    pending: total - completed - inProgress,
  };
}

/**
 * Get a short summary of session progress.
 *
 * @param workingDir - Project working directory
 * @param runtimeSeconds - Session runtime in seconds
 * @returns Summary string for display
 */
export function getProgressSummary(workingDir: string, runtimeSeconds: number): string {
  const phase = getPhaseStatus(workingDir);
  const runtime = formatRuntime(runtimeSeconds);

  return `${runtime} · ${phase}`;
}
