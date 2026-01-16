/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new command is triggered
 * Creates a new dated memory file with LLM-generated slug
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { InternalHookHandler } from '../../src/hooks/internal-hooks.js';

/**
 * Read recent messages from session file for slug generation
 */
async function getRecentSessionContent(sessionFilePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(sessionFilePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Get last 15 lines (recent conversation)
    const recentLines = lines.slice(-15);

    // Parse JSONL and extract messages
    const messages: string[] = [];
    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        // Session files have entries with type="message" containing a nested message object
        if (entry.type === 'message' && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === 'user' || role === 'assistant') && msg.content) {
            // Extract text content
            const text = Array.isArray(msg.content)
              ? msg.content.find((c: any) => c.type === 'text')?.text
              : msg.content;
            if (text && !text.startsWith('/')) {
              messages.push(`${role}: ${text}`);
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return messages.join('\n');
  } catch {
    return null;
  }
}

/**
 * Save session context to memory when /new command is triggered
 */
const saveSessionToMemory: InternalHookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== 'command' || event.action !== 'new') {
    return;
  }

  try {
    console.log('[session-memory] Hook triggered for /new command');

    // Resolve workspace directory (default: ~/clawd)
    const workspaceDir = path.join(os.homedir(), 'clawd');
    const memoryDir = path.join(workspaceDir, 'memory');
    await fs.mkdir(memoryDir, { recursive: true });

    // Get today's date for filename
    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    // Generate descriptive slug from session using LLM
    const context = event.context || {};
    const sessionEntry = (context.sessionEntry || {}) as Record<string, unknown>;
    const currentSessionId = sessionEntry.sessionId as string;
    const currentSessionFile = sessionEntry.sessionFile as string;
    const cfg = context.cfg;

    console.log('[session-memory] Current sessionId:', currentSessionId);
    console.log('[session-memory] Current sessionFile:', currentSessionFile);
    console.log('[session-memory] cfg present:', !!cfg);

    // Find the OLD session file (most recent before current)
    // The hook runs AFTER session reset, so current session is empty
    let sessionFile: string | undefined;
    try {
      const agentDir = path.dirname(path.dirname(currentSessionFile));
      const sessionsDir = path.join(agentDir, 'sessions');
      console.log('[session-memory] Looking for old session in:', sessionsDir);

      const files = await fs.readdir(sessionsDir);
      const sessionFiles = files
        .filter(f => f.endsWith('.jsonl') && f !== `${currentSessionId}.jsonl`)
        .map(f => path.join(sessionsDir, f));

      // Sort by modification time, get most recent
      const stats = await Promise.all(
        sessionFiles.map(async (filepath) => ({
          filepath,
          mtime: (await fs.stat(filepath)).mtime
        }))
      );

      const sortedByTime = stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      sessionFile = sortedByTime[0]?.filepath;

      console.log('[session-memory] Found old session file:', sessionFile);
    } catch (err) {
      console.error('[session-memory] Error finding old session:', err);
      sessionFile = undefined;
    }

    let slug: string | null = null;
    if (sessionFile && cfg) {
      // Get recent conversation content
      const sessionContent = await getRecentSessionContent(sessionFile);
      console.log('[session-memory] sessionContent length:', sessionContent?.length || 0);

      if (sessionContent) {
        console.log('[session-memory] Calling generateSlugViaLLM...');
        // Dynamically import the LLM slug generator (avoids module caching issues)
        const clawdbotRoot = path.resolve(path.dirname(import.meta.url.replace('file://', '')), '../..');
        const slugGenPath = path.join(clawdbotRoot, 'dist/hooks/llm-slug-generator.js');
        const { generateSlugViaLLM } = await import(slugGenPath);

        // Use LLM to generate a descriptive slug
        slug = await generateSlugViaLLM({ sessionContent, cfg });
        console.log('[session-memory] Generated slug:', slug);
      }
    }

    // If no slug, use timestamp
    if (!slug) {
      const timeSlug = now.toISOString().split('T')[1]!.split('.')[0]!.replace(/:/g, '');
      slug = timeSlug.slice(0, 4); // HHMM
      console.log('[session-memory] Using fallback timestamp slug:', slug);
    }

    // Create filename with date and slug
    const filename = `${dateStr}-${slug}.md`;
    const memoryFilePath = path.join(memoryDir, filename);
    console.log('[session-memory] Generated filename:', filename);
    console.log('[session-memory] Full path:', memoryFilePath);

    // Format time as HH:MM:SS UTC
    const timeStr = now.toISOString().split('T')[1]!.split('.')[0];

    // Extract context details
    const sessionId = (sessionEntry.sessionId as string) || 'unknown';
    const source = (context.commandSource as string) || 'unknown';

    // Build Markdown entry
    const entry = [
      `# Session: ${dateStr} ${timeStr} UTC`,
      '',
      `- **Session Key**: ${event.sessionKey}`,
      `- **Session ID**: ${sessionId}`,
      `- **Source**: ${source}`,
      '',
    ].join('\n');

    // Write to new memory file
    await fs.writeFile(memoryFilePath, entry, 'utf-8');
    console.log('[session-memory] Memory file written successfully');

    // Send confirmation message to user with filename
    const relPath = memoryFilePath.replace(os.homedir(), '~');
    const confirmMsg = `💾 Session context saved to memory before reset.\n📄 ${relPath}`;
    event.messages.push(confirmMsg);
    console.log('[session-memory] Confirmation message queued:', confirmMsg);
  } catch (err) {
    console.error(
      '[session-memory] Failed to save session memory:',
      err instanceof Error ? err.message : String(err)
    );
  }
};

export default saveSessionToMemory;
