import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

export async function withTempPdfAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

export function resetPdfToolAuthEnv(): void {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GOOGLE_API_KEY", "");
  vi.stubEnv("MINIMAX_API_KEY", "");
  vi.stubEnv("ZAI_API_KEY", "");
  vi.stubEnv("Z_AI_API_KEY", "");
  vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
}
