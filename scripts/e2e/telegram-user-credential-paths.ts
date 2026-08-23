// Telegram User Credential Paths script supports OpenClaw repository automation.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;
type PathImpl = Pick<typeof path, "dirname" | "join">;

export function expandHome(
  filePath: string,
  params: { env?: NodeJS.ProcessEnv; pathImpl?: PathImpl } = {},
) {
  const env = params.env ?? process.env;
  const pathImpl = params.pathImpl ?? path;
  const homeDir = env.HOME || env.USERPROFILE;
  if (filePath === "~") {
    return homeDir || filePath;
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return homeDir ? pathImpl.join(homeDir, filePath.slice(2)) : filePath;
  }
  return filePath;
}

export function resolvePrivateJsonDirectory(
  filePath: string,
  params: { env?: NodeJS.ProcessEnv; pathImpl?: PathImpl } = {},
) {
  const pathImpl = params.pathImpl ?? path;
  return pathImpl.dirname(expandHome(filePath, params));
}

export async function writePrivateJson(filePath: string, payload: JsonObject) {
  const expanded = expandHome(filePath);
  await mkdir(resolvePrivateJsonDirectory(filePath), { recursive: true });
  await writeFile(expanded, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmodPrivate(expanded);
}

async function chmodPrivate(filePath: string) {
  await chmod(filePath, 0o600);
}
