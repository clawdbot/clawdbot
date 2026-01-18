import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import path from "node:path";

import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const LobsterActions = ["run", "resume"] as const;

type LobsterToolParams = {
  action: (typeof LobsterActions)[number];
  pipeline?: string;
  token?: string;
  approve?: boolean;
  lobsterPath?: string;
  cwd?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
};

type LobsterEnvelope =
  | {
      ok: true;
      status: "ok" | "needs_approval" | "cancelled";
      output: unknown[];
      requiresApproval: null | {
        type: "approval_request";
        prompt: string;
        items: unknown[];
        resumeToken?: string;
      };
    }
  | {
      ok: false;
      error: { type?: string; message: string };
    };

function buildSchema() {
  return Type.Object({
    action: stringEnum(LobsterActions),
    pipeline: Type.Optional(Type.String({ description: "Lobster pipeline string." })),
    token: Type.Optional(Type.String({ description: "Resume token from lobster tool mode." })),
    approve: Type.Optional(Type.Boolean({ description: "Approval decision for resume." })),
    lobsterPath: Type.Optional(
      Type.String({
        description:
          "Path to lobster executable. Prefer an absolute path to avoid PATH hijack. Defaults to 'lobster'.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory for lobster subprocess.",
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description: "Subprocess timeout (ms).",
      }),
    ),
    maxStdoutBytes: Type.Optional(
      Type.Number({
        description: "Max stdout bytes to read before aborting.",
      }),
    ),
  });
}

function resolveExecutablePath(lobsterPathRaw: string | undefined) {
  const lobsterPath = lobsterPathRaw?.trim() || "lobster";
  if (lobsterPath !== "lobster" && !path.isAbsolute(lobsterPath)) {
    throw new Error("lobsterPath must be an absolute path (or omit to use PATH)");
  }
  return lobsterPath;
}

async function runLobsterSubprocess(params: {
  execPath: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
}) {
  const { execPath, argv, cwd } = params;
  const timeoutMs = Math.max(200, params.timeoutMs);
  const maxStdoutBytes = Math.max(1024, params.maxStdoutBytes);

  return await new Promise<{ stdout: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(execPath, argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure lobster never tries to be interactive.
        LOBSTER_MODE: "tool",
      },
    });

    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      const str = String(chunk);
      stdoutBytes += Buffer.byteLength(str, "utf8");
      if (stdoutBytes > maxStdoutBytes) {
        try {
          child.kill("SIGKILL");
        } finally {
          reject(new Error("lobster output exceeded maxStdoutBytes"));
        }
        return;
      }
      stdout += str;
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } finally {
        reject(new Error("lobster subprocess timed out"));
      }
    }, timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`lobster failed (${code ?? "?"}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({ stdout, exitCode: code });
    });
  });
}

function parseEnvelope(stdout: string): LobsterEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("lobster returned invalid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("lobster returned invalid JSON envelope");
  }

  const ok = (parsed as { ok?: unknown }).ok;
  if (ok === true) {
    const env = parsed as LobsterEnvelope;
    if (!Array.isArray((env as any).output)) {
      throw new Error("lobster tool output must include output[]");
    }
    return env;
  }

  if (ok === false) {
    const env = parsed as LobsterEnvelope;
    const msg = (env as any)?.error?.message;
    if (typeof msg !== "string" || !msg.trim()) {
      throw new Error("lobster error envelope missing error.message");
    }
    return env;
  }

  throw new Error("lobster returned invalid JSON envelope");
}

export function createLobsterTool(options: { sandboxed?: boolean } = {}): AnyAgentTool {
  const parameters = buildSchema();

  return {
    label: "Lobster",
    name: "lobster",
    description:
      "Run Lobster pipelines as a local-first, typed workflow runtime (tool mode JSON envelope, resumable approvals).",
    parameters,
    async execute(_callId, paramsRaw) {
      if (options.sandboxed) {
        throw new Error("lobster tool is not available in sandboxed mode");
      }

      const params = paramsRaw as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as LobsterToolParams["action"];

      const execPath = resolveExecutablePath(readStringParam(params, "lobsterPath"));
      const cwd = readStringParam(params, "cwd", { allowEmpty: false }) || process.cwd();

      const timeoutMs = readNumberParam(params, "timeoutMs", { integer: true }) ?? 20_000;
      const maxStdoutBytes = readNumberParam(params, "maxStdoutBytes", { integer: true }) ?? 512_000;

      let argv: string[];
      if (action === "run") {
        const pipeline = readStringParam(params, "pipeline", { required: true, label: "pipeline" })!;
        argv = ["run", "--mode", "tool", pipeline];
      } else if (action === "resume") {
        const token = readStringParam(params, "token", { required: true, label: "token" })!;
        const approve = params["approve"];
        if (typeof approve !== "boolean") {
          throw new Error("approve required");
        }
        argv = ["resume", "--token", token, "--approve", approve ? "yes" : "no"];
      } else {
        throw new Error(`Unknown action: ${action}`);
      }

      const { stdout } = await runLobsterSubprocess({
        execPath,
        argv,
        cwd,
        timeoutMs,
        maxStdoutBytes,
      });

      const envelope = parseEnvelope(stdout);
      return jsonResult(envelope);
    },
  };
}
