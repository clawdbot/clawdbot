import { spawn } from "node:child_process";
import type { CodexAppServerStartOptions } from "./config.js";
import type { CodexAppServerTransport } from "./transport.js";

export function createStdioTransport(options: CodexAppServerStartOptions): CodexAppServerTransport {
  const env = {
    ...process.env,
    ...options.env,
  };
  for (const key of options.clearEnv ?? []) {
    delete env[key];
  }
  return spawn(options.command, options.args, {
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}
