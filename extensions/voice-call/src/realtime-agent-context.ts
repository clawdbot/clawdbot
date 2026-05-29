import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildRealtimeVoiceAgentConsultPolicyInstructions } from "openclaw/plugin-sdk/realtime-voice";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString as normalizeString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";

type VoiceIdentityLike = {
  name?: unknown;
  emoji?: unknown;
  theme?: unknown;
  creature?: unknown;
  vibe?: unknown;
};

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n[truncated]`;
}

async function readWorkspaceVoiceContextFiles(params: {
  workspaceDir: string;
  files: readonly string[];
  maxChars: number;
}): Promise<string[]> {
  const sections: string[] = [];
  let remaining = params.maxChars;
  const workspaceRoot = await root(params.workspaceDir).catch(() => null);
  if (!workspaceRoot) {
    return sections;
  }
  for (const file of params.files) {
    if (remaining <= 0) {
      continue;
    }
    const content = await workspaceRoot.readText(file).catch(() => undefined);
    const trimmed = content?.trim();
    if (!trimmed) {
      continue;
    }
    const body = limitText(trimmed, Math.max(0, remaining - file.length - 16));
    const section = `### ${file}\n${body}`;
    sections.push(section);
    remaining -= section.length;
  }
  return sections;
}

export async function buildRealtimeVoiceInstructions(params: {
  baseInstructions: string;
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  agentRuntime: CoreAgentDeps;
}): Promise<string> {
  const { config } = params;
  const sections: string[] = [params.baseInstructions];
  const consultGuidance = buildRealtimeVoiceAgentConsultPolicyInstructions(config.realtime);
  if (consultGuidance) {
    sections.push(consultGuidance);
  }

  const contextConfig = config.realtime.agentContext;
  if (!contextConfig.enabled) {
    return sections.filter(Boolean).join("\n\n");
  }

  const agentId = config.agentId ?? "main";
  const capsule: string[] = [
    "OpenClaw agent voice context:",
    `- Agent id: ${agentId}`,
    "- Use this context to match the OpenClaw agent's personality and standing preferences on fast voice turns.",
    "- Treat this as compact context only; call openclaw_agent_consult when the caller needs the full agent brain, tools, memory, or workspace state.",
  ];

  if (contextConfig.includeIdentity) {
    const identity = params.agentRuntime.resolveAgentIdentity(
      params.coreConfig as OpenClawConfig,
      agentId,
    ) as VoiceIdentityLike | undefined;
    const identityLines = [
      normalizeString(identity?.name) ? `- Name: ${normalizeString(identity?.name)}` : undefined,
      normalizeString(identity?.emoji) ? `- Emoji: ${normalizeString(identity?.emoji)}` : undefined,
      normalizeString(identity?.vibe) ? `- Vibe: ${normalizeString(identity?.vibe)}` : undefined,
      normalizeString(identity?.theme) ? `- Theme: ${normalizeString(identity?.theme)}` : undefined,
      normalizeString(identity?.creature)
        ? `- Creature/persona: ${normalizeString(identity?.creature)}`
        : undefined,
    ].filter(Boolean);
    if (identityLines.length > 0) {
      capsule.push(`Configured identity:\n${identityLines.join("\n")}`);
    }
  }

  if (contextConfig.includeWorkspaceFiles) {
    const workspaceDir = params.agentRuntime.resolveAgentWorkspaceDir(
      params.coreConfig as OpenClawConfig,
      agentId,
    );
    const fileSections = await readWorkspaceVoiceContextFiles({
      workspaceDir,
      files: contextConfig.files,
      maxChars: contextConfig.maxChars,
    });
    if (fileSections.length > 0) {
      capsule.push(`Workspace voice context:\n${fileSections.join("\n\n")}`);
    }
  }

  sections.push(limitText(capsule.join("\n\n"), contextConfig.maxChars));
  return sections.filter(Boolean).join("\n\n");
}
