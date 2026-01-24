/**
 * Gateway Restart Notifier
 *
 * Sends a notification to the main session when gateway restarts,
 * informing DyDo what was happening before the restart.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadBubbleRegistry, type BubbleRegistryEntry } from "./claude-code/bubble-service.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const log = createSubsystemLogger("gateway/restart-notifier");

const RESTART_MARKER_PATH = path.join(os.homedir(), ".clawdbot", "last-restart.json");

interface RestartMarker {
  timestamp: number;
  pid: number;
  activeSessions: Array<{
    sessionId: string;
    projectName: string;
    resumeToken: string;
  }>;
  /** Context from main session before restart */
  mainSessionContext?: {
    chatId: string;
    threadId?: number;
    lastMessages: Array<{
      role: "user" | "assistant";
      content: string;
      timestamp: number;
    }>;
    pendingTask?: string;
  };
}

/**
 * Write restart marker before gateway stops.
 * Captures current context for resumption after restart.
 */
export async function writeRestartMarker(): Promise<void> {
  try {
    const registry = loadBubbleRegistry();

    // Check for pending task file (written by DyDo before committing/building)
    let mainSessionContext: RestartMarker["mainSessionContext"] = undefined;
    const pendingTaskPath = path.join(os.homedir(), ".clawdbot", "pending-task.txt");

    if (fs.existsSync(pendingTaskPath)) {
      try {
        const pendingTask = fs.readFileSync(pendingTaskPath, "utf-8").trim();
        if (pendingTask) {
          mainSessionContext = {
            chatId: "1359438700", // Hsc's user ID
            lastMessages: [],
            pendingTask,
          };
          log.info(`Captured pending task: ${pendingTask.slice(0, 100)}`);
        }
      } catch (err) {
        log.warn(`Could not read pending task: ${err}`);
      }
    }

    const marker: RestartMarker = {
      timestamp: Date.now(),
      pid: process.pid,
      activeSessions: registry.map((entry: BubbleRegistryEntry) => ({
        sessionId: entry.sessionId,
        projectName: entry.projectName,
        resumeToken: entry.resumeToken,
      })),
      mainSessionContext,
    };

    fs.writeFileSync(RESTART_MARKER_PATH, JSON.stringify(marker, null, 2), "utf-8");
    log.info(`Wrote restart marker with ${marker.activeSessions.length} active sessions`);
  } catch (err) {
    log.error(`Failed to write restart marker: ${err}`);
  }
}

/**
 * Notify main session about gateway restart.
 * Called after bubble recovery on startup.
 */
export async function notifyGatewayRestart(): Promise<void> {
  // Check if restart marker exists
  if (!fs.existsSync(RESTART_MARKER_PATH)) {
    log.info("No restart marker found - clean startup");
    return;
  }

  try {
    const markerData = fs.readFileSync(RESTART_MARKER_PATH, "utf-8");
    const marker: RestartMarker = JSON.parse(markerData);

    // Check if marker is recent (within last 5 minutes)
    const age = Date.now() - marker.timestamp;
    if (age > 5 * 60 * 1000) {
      log.info(`Restart marker too old (${Math.floor(age / 1000)}s) - ignoring`);
      fs.unlinkSync(RESTART_MARKER_PATH);
      return;
    }

    // Build notification message with context
    const activeSessions = marker.activeSessions.length;
    let message = `✅ **我回來了！**\n\n`;

    // Show pending task if available
    if (marker.mainSessionContext?.pendingTask) {
      message += `**重啟前正在處理：**\n`;
      message += `${marker.mainSessionContext.pendingTask}\n\n`;
      message += `讓我繼續...\n\n`;

      // Clean up pending task file
      const pendingTaskPath = path.join(os.homedir(), ".clawdbot", "pending-task.txt");
      try {
        fs.unlinkSync(pendingTaskPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Technical details
    message += `---\n`;
    message += `**PID:** ${process.pid} · **重啟:** ${new Date(marker.timestamp).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}\n`;

    if (activeSessions > 0) {
      message += `**進行中的 Claude Code:** ${activeSessions} sessions\n`;
    }

    // Send to main session via Telegram
    // Hardcoded for now - send to Hsc's user ID
    const { sendMessageTelegram } = await import("../telegram/send.js");
    const targetChatId = "1359438700"; // Hsc's Telegram user ID

    await sendMessageTelegram(targetChatId, message, {
      disableLinkPreview: true,
    });

    log.info(`Sent restart notification to ${targetChatId}`);

    // Clean up marker
    fs.unlinkSync(RESTART_MARKER_PATH);
  } catch (err) {
    log.error(`Failed to notify restart: ${err}`);
    // Try to clean up marker even on error
    try {
      fs.unlinkSync(RESTART_MARKER_PATH);
    } catch {
      // Ignore cleanup errors
    }
  }
}
