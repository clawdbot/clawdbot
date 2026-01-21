/**
 * Claude Code Session Manager
 *
 * Manages Claude Code as a subprocess, providing:
 * - Process lifecycle (start, cancel, send input)
 * - Session file watching for events
 * - Question detection and forwarding
 * - State tracking for UI updates
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  ClaudeCodeSessionParams,
  ClaudeCodeSessionData,
  SessionEvent,
  SessionState,
  SessionStatus,
  SessionStartResult,
} from "./types.js";
import {
  resolveProject,
  findSessionFile,
  getSessionDir,
  getGitBranch,
} from "./project-resolver.js";
import {
  SessionParser,
  extractRecentActions,
  getWaitingEvent,
  isSessionIdle,
} from "./session-parser.js";
import { getPhaseStatus } from "./progress-tracker.js";

const log = createSubsystemLogger("claude-code/session");

/**
 * Registry of active Claude Code sessions.
 */
const activeSessions = new Map<string, ClaudeCodeSessionData>();

/**
 * Get session by ID.
 */
export function getSession(sessionId: string): ClaudeCodeSessionData | undefined {
  return activeSessions.get(sessionId);
}

/**
 * Get session by resume token (or prefix).
 */
export function getSessionByToken(tokenOrPrefix: string): ClaudeCodeSessionData | undefined {
  for (const session of activeSessions.values()) {
    if (session.resumeToken === tokenOrPrefix || session.resumeToken.startsWith(tokenOrPrefix)) {
      return session;
    }
  }
  return undefined;
}

/**
 * List all active sessions.
 */
export function listSessions(): ClaudeCodeSessionData[] {
  return Array.from(activeSessions.values());
}

/**
 * Generate a short session ID.
 */
function generateSessionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Start a new Claude Code session.
 */
export async function startSession(params: ClaudeCodeSessionParams): Promise<SessionStartResult> {
  const sessionId = generateSessionId();

  // Resolve project directory (either workingDir or project must be provided)
  let workingDir: string;
  let projectName: string;
  let branch: string;

  if (params.workingDir) {
    workingDir = params.workingDir;
    branch = getGitBranch(workingDir);

    // Detect if this is a worktree and extract project name properly
    // Worktree paths look like: /path/to/project/.worktrees/branch
    const worktreeMatch = workingDir.match(/^(.+)\/\.worktrees\/([^/]+)\/?$/);
    if (worktreeMatch) {
      // It's a worktree - use parent project name only (branch shown in ctx: line)
      projectName = path.basename(worktreeMatch[1]);
    } else {
      // Regular directory
      projectName = path.basename(workingDir);
    }
  } else if (params.project) {
    const resolved = resolveProject(params.project);
    if (!resolved) {
      return {
        success: false,
        error: `Project not found: ${params.project}`,
      };
    }
    workingDir = resolved.workingDir;
    projectName = resolved.displayName;
    branch = resolved.branch;
  } else {
    return {
      success: false,
      error: "Either project or workingDir must be provided",
    };
  }

  // Check if directory exists
  if (!fs.existsSync(workingDir)) {
    return {
      success: false,
      error: `Directory does not exist: ${workingDir}`,
    };
  }

  log.info(`Starting Claude Code session for ${projectName} in ${workingDir}`);

  // Build command arguments
  const args: string[] = [];

  // Resume existing session or start new
  if (params.resumeToken) {
    args.push("--resume", params.resumeToken);
  }

  // Add prompt if provided (for new sessions or continue)
  if (params.prompt) {
    args.push("-p", params.prompt);
  }

  // Model selection
  if (params.model) {
    args.push("--model", params.model);
  }

  // Permission mode
  const permissionMode = params.permissionMode ?? "default";
  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else if (permissionMode === "acceptEdits") {
    args.push("--permission-mode", "acceptEdits");
  }

  // Spawn Claude Code process
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("claude", args, {
      cwd: workingDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure we get JSON output for parsing
        TERM: "dumb",
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`Failed to spawn Claude Code: ${error}`);
    return {
      success: false,
      error: `Failed to start Claude Code: ${error}`,
    };
  }

  if (!child.pid) {
    return {
      success: false,
      error: "Failed to get process ID",
    };
  }

  // Create session data
  const sessionData: ClaudeCodeSessionData = {
    id: sessionId,
    resumeToken: params.resumeToken ?? "", // Will be updated when we find session file
    projectName,
    workingDir,
    sessionFile: "", // Will be updated when session starts
    child,
    pid: child.pid,
    startedAt: Date.now(),
    status: "starting",
    onEvent: params.onEvent,
    onQuestion: params.onQuestion,
    onStateChange: params.onStateChange,
    eventCount: 0,
    events: [],
    recentActions: [],
    phaseStatus: "Starting",
    branch,
    isResume: !!params.resumeToken, // Track if this is a resumed session
    sessionStartTime: Date.now(), // Record start time for filtering old events
  };

  // Register session
  activeSessions.set(sessionId, sessionData);

  // Setup process event handlers
  setupProcessHandlers(sessionData);

  // Start watching for session file
  startSessionFileWatcher(sessionData);

  // Notify state change
  notifyStateChange(sessionData);

  log.info(`Session ${sessionId} started with PID ${child.pid}`);

  return {
    success: true,
    sessionId,
    resumeToken: sessionData.resumeToken,
  };
}

/**
 * Setup handlers for the child process.
 */
function setupProcessHandlers(session: ClaudeCodeSessionData): void {
  const { child } = session;
  if (!child) return;

  // Capture stdout (Claude Code output)
  child.stdout.on("data", (data: Buffer) => {
    const text = data.toString();
    log.debug(`[${session.id}] stdout: ${text.slice(0, 100)}...`);

    // Check for session token in output if we don't have it yet
    if (!session.resumeToken) {
      const tokenMatch = text.match(/Resume token: ([a-f0-9-]{36})/i);
      if (tokenMatch) {
        session.resumeToken = tokenMatch[1];
        log.info(`[${session.id}] Found resume token: ${session.resumeToken}`);
      }
    }
  });

  // Capture stderr
  child.stderr.on("data", (data: Buffer) => {
    const text = data.toString();
    log.warn(`[${session.id}] stderr: ${text}`);
  });

  // Handle process exit
  child.on("close", (code, signal) => {
    log.info(`[${session.id}] Process exited with code=${code}, signal=${signal}`);

    if (signal === "SIGTERM" || signal === "SIGKILL") {
      session.status = "cancelled";
    } else if (code === 0) {
      session.status = "completed";
    } else {
      session.status = "failed";
    }

    // Stop file watcher
    session.watcherAbort?.abort();

    // Notify state change
    notifyStateChange(session);

    // Keep session in registry for a while for status queries
    setTimeout(() => {
      activeSessions.delete(session.id);
    }, 60_000);
  });

  child.on("error", (err) => {
    log.error(`[${session.id}] Process error: ${err.message}`);
    session.status = "failed";
    notifyStateChange(session);
  });
}

/**
 * Start watching the session file for new events.
 */
function startSessionFileWatcher(session: ClaudeCodeSessionData): void {
  const abortController = new AbortController();
  session.watcherAbort = abortController;

  // Poll for session file and events
  const pollInterval = setInterval(() => {
    if (abortController.signal.aborted) {
      clearInterval(pollInterval);
      return;
    }

    // Find session file if we don't have it yet
    if (!session.sessionFile && session.resumeToken) {
      const sessionFile = findSessionFile(session.resumeToken);
      if (sessionFile) {
        session.sessionFile = sessionFile;
        const parser = new SessionParser(sessionFile);
        // Don't skip to end - we'll filter by timestamp instead
        // This ensures we catch new events even if Claude writes before we start watching
        session.parser = parser;
        log.info(`[${session.id}] Found session file: ${sessionFile}`);
      }
    }

    // Also try to find by scanning the session directory
    // IMPORTANT: Only pick up files created AFTER this session started
    // to avoid picking up old session files from previous runs
    if (!session.sessionFile) {
      const sessionDir = getSessionDir(session.workingDir);
      if (fs.existsSync(sessionDir)) {
        const files = fs
          .readdirSync(sessionDir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => {
            const filePath = path.join(sessionDir, f);
            const stat = fs.statSync(filePath);
            return {
              name: f,
              path: filePath,
              mtime: stat.mtime.getTime(),
              // Use birthtime (creation time) if available, otherwise mtime
              ctime: stat.birthtime?.getTime() ?? stat.mtime.getTime(),
            };
          })
          // Only consider files created AFTER session started (with 5s grace)
          .filter((f) => f.ctime >= session.startedAt - 5000)
          .sort((a, b) => b.mtime - a.mtime);

        if (files.length > 0) {
          session.sessionFile = files[0].path;
          // Extract token from filename
          const tokenMatch = files[0].name.match(/([a-f0-9-]{36})\.jsonl$/);
          if (tokenMatch && !session.resumeToken) {
            session.resumeToken = tokenMatch[1];
          }
          // Create parser for this session file
          const parser = new SessionParser(session.sessionFile);
          // Don't skip to end - we'll filter by timestamp instead
          session.parser = parser;
          log.info(`[${session.id}] Found session file: ${session.sessionFile}`);
        }
      }
    }

    // Parse new events from session file using the parser
    if (session.sessionFile && session.parser) {
      const parser = session.parser as SessionParser;
      const newEvents = parser.parseNew();
      if (newEvents.length > 0) {
        log.debug(`[${session.id}] Parsed ${newEvents.length} new events`);
      }
      for (const event of newEvents) {
        processEvent(session, event);
      }
    }
  }, 1000);

  // Store cleanup function
  abortController.signal.addEventListener("abort", () => {
    clearInterval(pollInterval);
  });
}

/**
 * Process a session event.
 */
function processEvent(session: ClaudeCodeSessionData, event: SessionEvent): void {
  // For resumed sessions, skip events that happened before we started
  // This filters out old history while still catching new events
  if (session.isResume && session.sessionStartTime) {
    const eventTime = event.timestamp.getTime();
    // Allow 5 second buffer before session start to catch events written during startup
    if (eventTime < session.sessionStartTime - 5000) {
      log.debug(
        `[${session.id}] Skipping old event (${event.type}) from ${event.timestamp.toISOString()}`,
      );
      return; // Skip old event
    }
    log.debug(
      `[${session.id}] Processing new event (${event.type}) from ${event.timestamp.toISOString()}`,
    );
  }

  session.eventCount++;
  session.events.push(event);

  // Keep events buffer bounded
  if (session.events.length > 1000) {
    session.events = session.events.slice(-500);
  }

  // Update status based on event
  if (session.status === "starting") {
    session.status = "running";
  }

  // Update recent actions using the parser helper
  session.recentActions = extractRecentActions(session.events, 10);

  // Update phase status from project files periodically (every 10 events)
  if (session.eventCount % 10 === 0) {
    session.phaseStatus = getPhaseStatus(session.workingDir);
  }

  // Check for questions using the parser helper
  const waitingEvent = getWaitingEvent(session.events);
  if (waitingEvent && waitingEvent.text) {
    session.status = "waiting_for_input";
    session.currentQuestion = waitingEvent.text;

    // Invoke question callback (only once per question)
    if (session.onQuestion && event === waitingEvent) {
      session
        .onQuestion(waitingEvent.text)
        .then((answer) => {
          if (answer) {
            sendInput(session.id, answer);
          }
        })
        .catch((err) => {
          log.error(`[${session.id}] Question handler error: ${err}`);
        });
    }
  } else if (event.type === "user_message") {
    // User responded, clear question state
    session.currentQuestion = undefined;
    session.status = "running";
  } else if (isSessionIdle(session.events)) {
    session.status = "idle";
  } else if (event.type === "tool_use") {
    session.status = "running";
  }

  // Notify event callback
  if (session.onEvent) {
    session.onEvent(event);
  }

  // Notify state change
  notifyStateChange(session);
}

/**
 * Notify state change callback.
 */
function notifyStateChange(session: ClaudeCodeSessionData): void {
  if (!session.onStateChange) return;

  const state = getSessionState(session);
  session.onStateChange(state);
}

/**
 * Get current session state.
 */
export function getSessionState(session: ClaudeCodeSessionData): SessionState {
  const runtimeSeconds = (Date.now() - session.startedAt) / 1000;
  const hours = Math.floor(runtimeSeconds / 3600);
  const minutes = Math.floor((runtimeSeconds % 3600) / 60);
  const runtimeStr = `${hours}h ${minutes}m`;

  return {
    status: session.status,
    projectName: session.projectName,
    resumeToken: session.resumeToken,
    runtimeStr,
    runtimeSeconds,
    phaseStatus: session.phaseStatus,
    branch: session.branch,
    recentActions: [...session.recentActions],
    hasQuestion: session.status === "waiting_for_input",
    questionText: session.currentQuestion ?? "",
    totalEvents: session.eventCount,
    isIdle: session.status === "idle",
  };
}

/**
 * Send input to a running session.
 */
export function sendInput(sessionId: string, text: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session || !session.child || session.child.killed) {
    log.warn(`Cannot send input to session ${sessionId}: not running`);
    return false;
  }

  try {
    session.child.stdin.write(text + "\n");
    log.info(`[${sessionId}] Sent input: ${text.slice(0, 50)}...`);
    return true;
  } catch (err) {
    log.error(`[${sessionId}] Failed to send input: ${err}`);
    return false;
  }
}

/**
 * Cancel a running session.
 */
export function cancelSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) {
    log.warn(`Cannot cancel session ${sessionId}: not found`);
    return false;
  }

  log.info(`Cancelling session ${sessionId}`);

  // Stop file watcher
  session.watcherAbort?.abort();

  // Kill process
  if (session.child && !session.child.killed) {
    session.child.kill("SIGTERM");

    // Force kill after timeout
    setTimeout(() => {
      if (session.child && !session.child.killed) {
        session.child.kill("SIGKILL");
      }
    }, 5000);
  }

  session.status = "cancelled";
  notifyStateChange(session);

  return true;
}

/**
 * Cancel session by token prefix.
 */
export function cancelSessionByToken(tokenOrPrefix: string): boolean {
  const session = getSessionByToken(tokenOrPrefix);
  if (!session) {
    return false;
  }
  return cancelSession(session.id);
}
