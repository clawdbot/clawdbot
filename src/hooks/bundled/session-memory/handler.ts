/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new command is triggered
 * Creates a new dated memory file with LLM-generated slug and summary
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ClawdbotConfig } from "../../../config/config.js";
import { resolveAgentWorkspaceDir, resolveAgentDir } from "../../../agents/agent-scope.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import type { HookHandler } from "../../hooks.js";

/** Patterns to filter out noise from session content */
const NOISE_PATTERNS = [
  /^Read HEARTBEAT\.md/i,
  /^HEARTBEAT_OK$/i,
  /^NO_REPLY$/i,
  /^\s*$/,
  /^System:/,
];

/** Maximum characters to send to LLM for summarization */
const MAX_CONTENT_CHARS = 50000;

/** Maximum characters for slug generation (smaller context) */
const MAX_SLUG_CHARS = 2000;

/**
 * Check if a message should be filtered out as noise
 */
function isNoise(text: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

/**
 * Extract all meaningful messages from session file
 * Filters out heartbeats, NO_REPLY, tool blocks, and other noise
 */
async function getFullSessionContent(sessionFilePath: string): Promise<{
  messages: string[];
  userMessages: string[];
  assistantMessages: string[];
} | null> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");

    const messages: string[] = [];
    const userMessages: string[] = [];
    const assistantMessages: string[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Session files have entries with type="message" containing a nested message object
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === "user" || role === "assistant") && msg.content) {
            // Extract text content
            let text: string | undefined;
            if (Array.isArray(msg.content)) {
              // Find text content blocks, skip tool_use/tool_result
              const textBlock = msg.content.find(
                (c: any) => c.type === "text" && typeof c.text === "string",
              );
              text = textBlock?.text;
            } else if (typeof msg.content === "string") {
              text = msg.content;
            }

            // Skip if no text, starts with slash command, or is noise
            if (!text || text.startsWith("/") || isNoise(text)) {
              continue;
            }

            // Truncate very long messages to avoid blowing up context
            const truncated = text.length > 2000 ? text.slice(0, 2000) + "..." : text;

            const formatted = `${role}: ${truncated}`;
            messages.push(formatted);

            if (role === "user") {
              userMessages.push(truncated);
            } else {
              assistantMessages.push(truncated);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return { messages, userMessages, assistantMessages };
  } catch {
    return null;
  }
}

/**
 * Generate LLM summary of session content
 */
async function generateSummaryViaLLM(params: {
  sessionContent: string;
  cfg: ClawdbotConfig;
  agentId: string;
  workspaceDir: string;
}): Promise<string | null> {
  let tempSessionFile: string | null = null;

  try {
    const { runEmbeddedPiAgent } = await import("../../../agents/pi-embedded.js");
    const agentDir = resolveAgentDir(params.cfg, params.agentId);

    // Create a temporary session file for this one-off LLM call
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-summary-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    const prompt = `Summarize this session for future memory recall. Be concise but complete.

Include:
- **Topics**: Main subjects discussed
- **Decisions**: Key decisions or conclusions reached
- **Outcomes**: What was accomplished or resolved
- **Open Items**: Any unfinished tasks or questions (if applicable)

Skip routine/administrative messages. Focus on substance.

Session transcript:
${params.sessionContent}

Write the summary in Markdown format, suitable for a memory file.`;

    const result = await runEmbeddedPiAgent({
      sessionId: `summary-generator-${Date.now()}`,
      sessionKey: "temp:summary-generator",
      sessionFile: tempSessionFile,
      workspaceDir: params.workspaceDir,
      agentDir,
      config: params.cfg,
      prompt,
      timeoutMs: 30_000, // 30 second timeout for summary
      runId: `summary-gen-${Date.now()}`,
    });

    // Clean up temp files
    try {
      await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Extract text from payloads
    if (result.payloads && result.payloads.length > 0) {
      const text = result.payloads[0]?.text;
      if (text) {
        return text.trim();
      }
    }

    console.error("[session-memory] LLM summary returned no content");
    return null;
  } catch (err) {
    console.error(
      "[session-memory] Summary generation error:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    // Ensure cleanup
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
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
    const cfg = context.cfg as ClawdbotConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(os.homedir(), "clawd");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    // Get today's date for filename
    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD

    // Get session entry info
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

    let slug: string | null = null;
    let summary: string | null = null;
    let rawContent: string | null = null;

    if (sessionFile) {
      // Get full conversation content (filtered)
      const parsed = await getFullSessionContent(sessionFile);
      console.log("[session-memory] Parsed messages:", parsed?.messages.length || 0);

      if (parsed && parsed.messages.length > 0) {
        // Prepare content for LLM (cap at max chars)
        const fullContent = parsed.messages.join("\n\n");
        rawContent = fullContent.slice(0, MAX_CONTENT_CHARS);

        if (cfg) {
          // Generate slug from recent content (smaller context)
          const slugContent = parsed.messages.slice(-10).join("\n").slice(0, MAX_SLUG_CHARS);

          console.log("[session-memory] Generating slug...");
          try {
            const clawdbotRoot = path.resolve(
              path.dirname(import.meta.url.replace("file://", "")),
              "../..",
            );
            const slugGenPath = path.join(clawdbotRoot, "llm-slug-generator.js");
            const { generateSlugViaLLM } = await import(slugGenPath);
            slug = await generateSlugViaLLM({ sessionContent: slugContent, cfg });
            console.log("[session-memory] Generated slug:", slug);
          } catch (err) {
            console.error("[session-memory] Slug generation failed:", err);
          }

          // Generate full summary via LLM
          console.log("[session-memory] Generating summary...");
          summary = await generateSummaryViaLLM({
            sessionContent: rawContent,
            cfg,
            agentId,
            workspaceDir,
          });
          console.log("[session-memory] Summary generated:", summary ? "yes" : "no");
        }
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

    // Include LLM-generated summary if available
    if (summary) {
      entryParts.push("## Summary", "", summary, "");
    } else if (rawContent) {
      // Fallback to raw content if summary generation failed
      entryParts.push(
        "## Conversation Excerpt",
        "",
        "_Note: LLM summary unavailable, showing raw content_",
        "",
        rawContent.slice(0, 5000),
        "",
      );
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
