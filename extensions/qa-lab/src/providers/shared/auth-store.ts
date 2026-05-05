import fs from "node:fs/promises";
import path from "node:path";

type QaAuthProfileCredential =
  | {
      type: "api_key";
      provider: string;
      key: string;
      displayName?: string;
    }
  | {
      type: "token";
      provider: string;
      token: string;
    };

export function resolveQaAgentAuthDir(params: { stateDir: string; agentId: string }): string {
  return path.join(params.stateDir, "agents", params.agentId, "agent");
}

export async function writeQaAuthProfiles(params: {
  agentDir: string;
  profiles: Record<string, QaAuthProfileCredential>;
}): Promise<void> {
  const authPath = path.join(params.agentDir, "auth-profiles.json");
  const existing = await fs
    .readFile(authPath, "utf8")
    .then((raw) => JSON.parse(raw) as { profiles?: Record<string, QaAuthProfileCredential> })
    .catch(() => ({ profiles: {} }));
  await fs.mkdir(params.agentDir, { recursive: true });
  await fs.writeFile(
    authPath,
    `${JSON.stringify({ version: 1, profiles: { ...existing.profiles, ...params.profiles } }, null, 2)}\n`,
    "utf8",
  );
}
