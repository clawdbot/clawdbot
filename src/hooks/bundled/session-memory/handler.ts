/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new command is triggered
 * Creates a new dated memory file with LLM-generated slug
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { MoltbotConfig } from "../../../config/config.js";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";

/**
 * Read recent messages from session file for slug generation
 */
async function getRecentSessionContent(
  sessionFilePath: string,
  messageCount: number = 15,
): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    // Parse JSONL and extract user/assistant messages first
    const allMessages: string[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Session files have entries with type="message" containing a nested message object
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === "user" || role === "assistant") && msg.content) {
            // Extract text content
            const text = Array.isArray(msg.content)
              ? msg.content.find((c: any) => c.type === "text")?.text
              : msg.content;
            if (text && !text.startsWith("/")) {
              allMessages.push(`${role}: ${text}`);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    // Then slice to get exactly messageCount messages
    const recentMessages = allMessages.slice(-messageCount);
    return recentMessages.join("\n");
  } catch {
    return null;
  }
}

/**
 * Save session context to memory when /new command is triggered
 */
const saveSessionToMemory: HookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  try {
    console.log("[session-memory] Hook triggered for /new command");

    const context = event.context || {};
    const cfg = context.cfg as MoltbotConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(os.homedir(), "clawd");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    // Get today's date for filename
    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD

    // Generate descriptive slug from session using LLM
    const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<
      string,
      unknown
    >;
    const currentSessionId = sessionEntry.sessionId as string;
    const currentSessionFile = sessionEntry.sessionFile as string;

    console.log("[session-memory] Current sessionId:", currentSessionId);
    console.log("[session-memory] Current sessionFile:", currentSessionFile);
    console.log("[session-memory] cfg present:", !!cfg);

    const sessionFile = currentSessionFile || undefined;

    // Read message count from hook config (default: 15)
    const hookConfig = resolveHookConfig(cfg, "session-memory");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : 15;

    let slug: string | null = null;
    let sessionContent: string | null = null;

    if (sessionFile) {
      // Get recent conversation content
      sessionContent = await getRecentSessionContent(sessionFile, messageCount);
      console.log("[session-memory] sessionContent length:", sessionContent?.length || 0);

      if (sessionContent && cfg) {
        console.log("[session-memory] Calling generateSlugViaLLM...");
        // Dynamically import the LLM slug generator (avoids module caching issues)
        // When compiled, handler is at dist/hooks/bundled/session-memory/handler.js
        // Going up ../.. puts us at dist/hooks/, so just add llm-slug-generator.js
        const moltbotRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
        const slugGenPath = path.join(moltbotRoot, "llm-slug-generator.js");
        const { generateSlugViaLLM } = await import(slugGenPath);

        // Use LLM to generate a descriptive slug
        slug = await generateSlugViaLLM({ sessionContent, cfg });
        console.log("[session-memory] Generated slug:", slug);
      }
    }

    // If no slug, use timestamp
    if (!slug) {
      const timeSlug = now.toISOString().split("T")[1]!.split(".")[0]!.replace(/:/g, "");
      slug = timeSlug.slice(0, 4); // HHMM
      console.log("[session-memory] Using fallback timestamp slug:", slug);
    }

    // Create filename with date and slug
    const filename = `${dateStr}-${slug}.md`;
    const memoryFilePath = path.join(memoryDir, filename);
    console.log("[session-memory] Generated filename:", filename);
    console.log("[session-memory] Full path:", memoryFilePath);

    // Format time as HH:MM:SS UTC
    const timeStr = now.toISOString().split("T")[1]!.split(".")[0];

    // Extract context details
    const sessionId = (sessionEntry.sessionId as string) || "unknown";
    const source = (context.commandSource as string) || "unknown";

    // Build Markdown entry
    const entryParts = [
      `# Session: ${dateStr} ${timeStr} UTC`,
      "",
      `- **Session Key**: ${event.sessionKey}`,
      `- **Session ID**: ${sessionId}`,
      `- **Source**: ${source}`,
      "",
    ];

    // Include conversation content if available
    if (sessionContent) {
      entryParts.push("## Conversation Summary", "", sessionContent, "");
    }

    const entry = entryParts.join("\n");

    // Write to new memory file
    await fs.writeFile(memoryFilePath, entry, "utf-8");
    console.log("[session-memory] Memory file written successfully");

    // Log completion (but don't send user-visible confirmation - it's internal housekeeping)
    const relPath = memoryFilePath.replace(os.homedir(), "~");
    console.log(`[session-memory] Session context saved to ${relPath}`);
  } catch (err) {
    console.error(
      "[session-memory] Failed to save session memory:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default saveSessionToMemory;
