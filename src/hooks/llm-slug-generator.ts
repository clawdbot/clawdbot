/**
 * LLM-based slug generator for session memory filenames
 */

import { randomUUID } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveAgentDir,
} from "../agents/agent-scope.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { SessionManager } from "../agents/sessions/index.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  extractLeadingHttpStatus,
  parseApiErrorPayload,
} from "../shared/assistant-error-format.js";

const log = createSubsystemLogger("llm-slug-generator");
const DEFAULT_SLUG_GENERATOR_TIMEOUT_MS = 15_000;
const PROVIDER_ERROR_PREFIX_RE =
  /^(?:provider\s+)?(?:api|llm|model|openai|anthropic|codex|gateway)\s+(?:request\s+)?(?:error|failed|failure)\b/i;
const PROVIDER_ERROR_DETAIL_RE =
  /\b(?:insufficient[_ -]?quota|quota (?:exceeded|exhausted)|exceeded your current quota|payment required|insufficient credits|credit balance|insufficient[_ -]?(?:balance|funds)|rate[_ -]?limit(?:ed)?|too many requests|invalid[_ -]?api[_ -]?key|incorrect api key|authentication failed|oauth token refresh failed|missing (?:token|projectid|credentials)|google cloud credentials|re-?authenticate|unauthorized|forbidden|permission_error|billing hard limit|spend(?:ing)? limit)\b/i;

function resolveSlugGeneratorTimeoutMs(cfg: OpenClawConfig): number {
  const configuredTimeoutSeconds = cfg.agents?.defaults?.timeoutSeconds;
  if (typeof configuredTimeoutSeconds !== "number" || !Number.isFinite(configuredTimeoutSeconds)) {
    return DEFAULT_SLUG_GENERATOR_TIMEOUT_MS;
  }
  return resolveAgentTimeoutMs({ cfg });
}

function isErrorSlugPayload(payload: { text?: string; isError?: boolean } | undefined): boolean {
  if (!payload) {
    return false;
  }
  if (payload.isError === true) {
    return true;
  }
  const text = payload.text?.trim();
  if (!text) {
    return false;
  }
  if (parseApiErrorPayload(text)) {
    return true;
  }
  const leadingStatus = extractLeadingHttpStatus(text);
  if (leadingStatus) {
    if ([401, 402, 403, 429].includes(leadingStatus.code)) {
      return true;
    }
    if (
      leadingStatus.code === 400 &&
      (parseApiErrorPayload(leadingStatus.rest) ||
        PROVIDER_ERROR_PREFIX_RE.test(leadingStatus.rest) ||
        PROVIDER_ERROR_DETAIL_RE.test(leadingStatus.rest))
    ) {
      return true;
    }
  }
  return PROVIDER_ERROR_PREFIX_RE.test(text) || PROVIDER_ERROR_DETAIL_RE.test(text);
}

/**
 * Generate a short 1-2 word filename slug from session content using LLM
 */
export async function generateSlugViaLLM(params: {
  sessionContent: string;
  cfg: OpenClawConfig;
  /** Optional hook-level override; the embedded runner owns model resolution. */
  model?: string;
}): Promise<string | null> {
  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId);

    const sessionId = `slug-generator-${randomUUID()}`;
    const sessionKey = `agent:${agentId}:helper:incognito-${sessionId}`;

    const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
${truncateUtf16Safe(params.sessionContent, 2000)}

Reply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix"`;

    const timeoutMs = resolveSlugGeneratorTimeoutMs(params.cfg);

    const result = await runEmbeddedAgent({
      sessionId,
      sessionKey,
      sessionManager: SessionManager.inMemory(workspaceDir),
      agentId,
      workspaceDir,
      agentDir,
      config: params.cfg,
      prompt,
      model: params.model,
      timeoutMs,
      runId: `slug-gen-${Date.now()}`,
      cleanupBundleMcpOnRunEnd: true,
      // Internal helper run: route failures lane-local so an upstream 400/billing
      // here cannot poison the shared profile (#71709).
      authProfileFailurePolicy: "local",
    });

    // Extract text from payloads
    if (result.payloads && result.payloads.length > 0) {
      const payload = result.payloads[0];
      const text = payload?.text;
      if (text) {
        if (isErrorSlugPayload(payload)) {
          return null;
        }
        // Clean up the response - extract just the slug
        const slug = normalizeLowercaseStringOrEmpty(text)
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 30)
          .replace(/^-+|-+$/g, ""); // Max 30 chars

        return slug || null;
      }
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`Failed to generate slug: ${message}`);
    return null;
  }
}
