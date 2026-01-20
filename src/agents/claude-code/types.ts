/**
 * Claude Code Session Types
 *
 * Type definitions for managing Claude Code sessions as subprocesses.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Parameters for starting a Claude Code session.
 */
export interface ClaudeCodeSessionParams {
  /** Project identifier (e.g., "juzi" or "juzi @experimental") */
  project: string;

  /** Initial prompt to send to Claude Code */
  prompt?: string;

  /** Resume a specific session by token */
  resumeToken?: string;

  /** Override working directory (resolved from project if not provided) */
  workingDir?: string;

  /** Model to use (opus, sonnet, haiku) */
  model?: "opus" | "sonnet" | "haiku";

  /** Permission mode for Claude Code */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions";

  /** Callback for session events */
  onEvent?: (event: SessionEvent) => void;

  /** Callback for questions (return answer to send back) */
  onQuestion?: (question: string) => Promise<string | null>;

  /** Callback for session state changes */
  onStateChange?: (state: SessionState) => void;
}

/**
 * Event types from Claude Code session file.
 */
export type SessionEventType =
  | "assistant_message"
  | "user_message"
  | "tool_use"
  | "tool_result"
  | "summary"
  | "system";

/**
 * A single event parsed from the session .jsonl file.
 */
export interface SessionEvent {
  type: SessionEventType;
  timestamp: Date;
  text?: string;
  toolName?: string;
  toolInput?: string;
  isWaitingForInput?: boolean;
  raw?: Record<string, unknown>;
}

/**
 * Current state of the session.
 */
export type SessionStatus =
  | "starting"
  | "running"
  | "waiting_for_input"
  | "idle"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Snapshot of session state for UI updates.
 */
export interface SessionState {
  /** Session status */
  status: SessionStatus;

  /** Project name (e.g., "juzi @experimental") */
  projectName: string;

  /** Resume token for this session */
  resumeToken: string;

  /** Runtime in human-readable format (e.g., "0h 12m") */
  runtimeStr: string;

  /** Runtime in seconds */
  runtimeSeconds: number;

  /** Current phase status (e.g., "Phase 3 in progress") */
  phaseStatus: string;

  /** Git branch */
  branch: string;

  /** Recent actions for display */
  recentActions: Array<{ icon: string; description: string }>;

  /** Whether Claude is waiting for user input */
  hasQuestion: boolean;

  /** The question text if waiting */
  questionText: string;

  /** Total events processed */
  totalEvents: number;

  /** Whether session is idle (no active tool use) */
  isIdle: boolean;
}

/**
 * Internal session data stored in registry.
 */
export interface ClaudeCodeSessionData {
  /** Unique session ID */
  id: string;

  /** Resume token (UUID) */
  resumeToken: string;

  /** Project name */
  projectName: string;

  /** Working directory */
  workingDir: string;

  /** Path to session .jsonl file */
  sessionFile: string;

  /** Child process handle */
  child?: ChildProcessWithoutNullStreams;

  /** Process ID */
  pid?: number;

  /** Start time */
  startedAt: number;

  /** Current status */
  status: SessionStatus;

  /** Event callbacks */
  onEvent?: (event: SessionEvent) => void;
  onQuestion?: (question: string) => Promise<string | null>;
  onStateChange?: (state: SessionState) => void;

  /** File watcher abort controller */
  watcherAbort?: AbortController;

  /** Session parser instance */
  parser?: unknown; // SessionParser - using unknown to avoid circular import

  /** Parsed events count */
  eventCount: number;

  /** All parsed events (for state tracking) */
  events: SessionEvent[];

  /** Recent actions buffer */
  recentActions: Array<{ icon: string; description: string }>;

  /** Current phase status */
  phaseStatus: string;

  /** Git branch */
  branch: string;

  /** Current question if any */
  currentQuestion?: string;
}

/**
 * Result of starting a session.
 */
export interface SessionStartResult {
  /** Whether start was successful */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** Session ID for tracking */
  sessionId?: string;

  /** Resume token */
  resumeToken?: string;
}

/**
 * Project resolution result.
 */
export interface ResolvedProject {
  /** Full path to project directory */
  workingDir: string;

  /** Display name (e.g., "juzi @experimental") */
  displayName: string;

  /** Git branch */
  branch: string;

  /** Whether this is a worktree */
  isWorktree: boolean;

  /** Main project name (without worktree suffix) */
  mainProject: string;

  /** Worktree name if applicable */
  worktreeName?: string;
}
