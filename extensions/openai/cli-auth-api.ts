import { spawn } from "node:child_process";
import { signalProcessTree } from "openclaw/plugin-sdk/process-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import packageJson from "./package.json" with { type: "json" };

type CodexCliAccount =
  | { type: "apiKey" }
  | { type: "chatgpt"; email?: string }
  | { type: "none"; requiresOpenaiAuth: boolean }
  | { type: "unknown" };

function projectCodexCliAccount(response: Record<string, unknown>): CodexCliAccount | null {
  const account = response.account;
  if (account === null && typeof response.requiresOpenaiAuth === "boolean") {
    return { type: "none", requiresOpenaiAuth: response.requiresOpenaiAuth };
  }
  if (!isRecord(account) || typeof account.type !== "string") {
    return null;
  }
  if (account.type === "apiKey") {
    return { type: "apiKey" };
  }
  if (account.type !== "chatgpt") {
    return { type: "unknown" };
  }
  const email = normalizeOptionalString(account.email);
  return {
    type: "chatgpt",
    ...(email && email.length <= 320 && !/[\r\n]/u.test(email) ? { email } : {}),
  };
}

/** Reads the native account before setup has installed a harness or configured an agent. */
export async function readCodexCliAccount(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexCliAccount | null> {
  const env = params.env ?? process.env;
  // Windows native home lookup ignores HOME/USERPROFILE; injected environments need CODEX_HOME.
  if (
    env !== process.env &&
    !env.CODEX_HOME?.trim() &&
    (process.platform === "win32" || !env.HOME?.trim())
  ) {
    return null;
  }
  try {
    const program = resolveWindowsSpawnProgram({
      command: params.command,
      env,
      packageName: "@openai/codex",
    });
    const invocation = materializeWindowsSpawnProgram(program, [
      "app-server",
      "--listen",
      "stdio://",
    ]);
    const detached = process.platform !== "win32";
    const child = spawn(invocation.command, invocation.argv, {
      env,
      detached,
      stdio: ["pipe", "pipe", "ignore"],
      shell: invocation.shell,
      windowsHide: invocation.windowsHide ?? true,
    });
    return await new Promise<CodexCliAccount | null>((resolve) => {
      let phase: "initialize" | "account" | "closing" | "closed" = "initialize";
      let result: CodexCliAccount | null = null;
      let output = "";
      let outputBytes = 0;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (phase === "closed") {
          return;
        }
        phase = "closed";
        clearTimeout(timer);
        clearTimeout(cleanupTimer);
        const complete = () => {
          // A bounded taskkill attempt can fail; still stop our live direct child.
          if (!detached && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          child.stdin.destroy();
          child.stdout.destroy();
          child.unref();
          resolve(result);
        };
        // A Unix group can outlive its leader. Finish signaling before the caller
        // terminates its worker; Windows must not target an already-exited root PID.
        if (child.pid && (detached || (child.exitCode === null && child.signalCode === null))) {
          signalProcessTree(child.pid, "SIGKILL", { detached, onComplete: complete });
        } else {
          complete();
        }
      };
      const stop = (account: CodexCliAccount | null) => {
        if (phase === "closing" || phase === "closed") {
          return;
        }
        phase = "closing";
        result = account;
        output = "";
        // Windows must enumerate the live tree before terminating its root.
        if (!detached || !child.pid) {
          finish();
          return;
        }
        signalProcessTree(child.pid, "SIGTERM", { detached });
        cleanupTimer = setTimeout(finish, 200);
      };
      const timer = setTimeout(finish, 3_000);
      const send = (messages: object[]) => {
        try {
          child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
        } catch {
          stop(null);
        }
      };
      child.once("error", () => stop(null));
      child.once("close", finish);
      child.stdin.on("error", () => stop(null));
      child.stdout.on("error", () => stop(null));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (phase === "closing" || phase === "closed") {
          return;
        }
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 64 * 1024) {
          stop(null);
          return;
        }
        output += chunk;
        let newline: number;
        while ((newline = output.indexOf("\n")) !== -1) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          try {
            const message: unknown = JSON.parse(line);
            if (
              !isRecord(message) ||
              "method" in message ||
              message.id !== (phase === "initialize" ? 1 : 2)
            ) {
              continue;
            }
            if (message.error || !isRecord(message.result)) {
              stop(null);
              return;
            }
            if (phase === "initialize") {
              phase = "account";
              send([
                { method: "initialized" },
                { id: 2, method: "account/read", params: { refreshToken: false } },
              ]);
            } else {
              stop(projectCodexCliAccount(message.result));
              return;
            }
          } catch {
            stop(null);
            return;
          }
        }
      });
      // Codex closes its connection on stdin EOF, so keep it open until account/read answers.
      send([
        {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "openclaw", title: "OpenClaw", version: packageJson.version },
          },
        },
      ]);
    });
  } catch {
    return null;
  }
}
