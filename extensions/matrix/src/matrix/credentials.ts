import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveStateDir } from "../../../../src/config/paths.js";

export type MatrixStoredCredentials = {
  homeserver: string;
  userId: string;
  accessToken: string;
  createdAt: string;
  lastUsedAt?: string;
};

const CREDENTIALS_FILENAME = "credentials.json";

export function resolveMatrixCredentialsDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, os.homedir),
): string {
  return path.join(stateDir, "credentials", "matrix");
}

export function resolveMatrixCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolveMatrixCredentialsDir(env);
  return path.join(dir, CREDENTIALS_FILENAME);
}

export function loadMatrixCredentials(
  env: NodeJS.ProcessEnv = process.env,
): MatrixStoredCredentials | null {
  const credPath = resolveMatrixCredentialsPath(env);
  try {
    if (!fs.existsSync(credPath)) return null;
    const raw = fs.readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MatrixStoredCredentials>;
    if (
      typeof parsed.homeserver !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.accessToken !== "string"
    ) {
      return null;
    }
    return parsed as MatrixStoredCredentials;
  } catch {
    return null;
  }
}

export function saveMatrixCredentials(
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = resolveMatrixCredentialsDir(env);
  fs.mkdirSync(dir, { recursive: true });

  const credPath = resolveMatrixCredentialsPath(env);

  const existing = loadMatrixCredentials(env);
  const now = new Date().toISOString();

  const toSave: MatrixStoredCredentials = {
    ...credentials,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  };

  fs.writeFileSync(credPath, JSON.stringify(toSave, null, 2), "utf-8");
}

export function touchMatrixCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const existing = loadMatrixCredentials(env);
  if (!existing) return;

  existing.lastUsedAt = new Date().toISOString();
  const credPath = resolveMatrixCredentialsPath(env);
  fs.writeFileSync(credPath, JSON.stringify(existing, null, 2), "utf-8");
}

export function clearMatrixCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const credPath = resolveMatrixCredentialsPath(env);
  try {
    if (fs.existsSync(credPath)) {
      fs.unlinkSync(credPath);
    }
  } catch {
    // ignore
  }
}

export function credentialsMatchConfig(
  stored: MatrixStoredCredentials,
  config: { homeserver: string; userId: string },
): boolean {
  return stored.homeserver === config.homeserver && stored.userId === config.userId;
}
