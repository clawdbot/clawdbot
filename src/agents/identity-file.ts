import fs from "node:fs";
import path from "node:path";

import { DEFAULT_IDENTITY_FILENAME } from "./workspace.js";

export type AgentIdentityFile = {
  name?: string;
  emoji?: string;
  theme?: string;
  creature?: string;
  vibe?: string;
  avatar?: string;
};

export function parseIdentityMarkdown(content: string): AgentIdentityFile {
  const identity: AgentIdentityFile = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colonIndex = cleaned.indexOf(":");
    if (colonIndex === -1) continue;
    const label = cleaned.slice(0, colonIndex).replace(/[*_]/g, "").trim().toLowerCase();
    const value = cleaned
      .slice(colonIndex + 1)
      .replace(/^[*_]+|[*_]+$/g, "")
      .trim();
    if (!value) continue;
    if (label === "name") identity.name = value;
    if (label === "emoji") identity.emoji = value;
    if (label === "creature") identity.creature = value;
    if (label === "vibe") identity.vibe = value;
    if (label === "theme") identity.theme = value;
    if (label === "avatar") identity.avatar = value;
  }
  return identity;
}

export function identityHasValues(identity: AgentIdentityFile): boolean {
  return Boolean(
    identity.name ||
    identity.emoji ||
    identity.theme ||
    identity.creature ||
    identity.vibe ||
    identity.avatar,
  );
}

export function loadIdentityFromFile(identityPath: string): AgentIdentityFile | null {
  try {
    const content = fs.readFileSync(identityPath, "utf-8");
    const parsed = parseIdentityMarkdown(content);
    if (!identityHasValues(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function loadAgentIdentityFromWorkspace(workspace: string): AgentIdentityFile | null {
  const identityPath = path.join(workspace, DEFAULT_IDENTITY_FILENAME);
  return loadIdentityFromFile(identityPath);
}
