import { spawn } from "node:child_process";
import path from "node:path";
import type {
  AiExecuteParams,
  AiExecuteResult,
} from "./protocol/schema/ai-intelligence.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

function resolveRuntimePaths(env: NodeJS.ProcessEnv = process.env) {
  const root = path.resolve(env.OPENCLAW_AI_INTELLIGENCE_ROOT ?? process.cwd());
  return {
    root,
    python:
      env.OPENCLAW_AI_INTELLIGENCE_PYTHON ??
      path.join(root, "tools", "ai_intelligence", ".venv", "bin", "python"),
    bridge:
      env.OPENCLAW_AI_INTELLIGENCE_BRIDGE ??
      path.join(root, "tools", "ai_intelligence", "gateway_bridge.py"),
  };
}

export function isAiIntelligenceGatewayEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.OPENCLAW_AI_INTELLIGENCE_GATEWAY_ENABLED === "1";
}

export async function executeAiIntelligenceGatewayRequest(
  params: AiExecuteParams,
): Promise<AiExecuteResult> {
  const runtime = resolveRuntimePaths();
  const processTimeoutMs = Math.ceil((params.timeoutSeconds ?? 60) * 1000) + 5000;

  return await new Promise<AiExecuteResult>((resolve, reject) => {
    const child = spawn(runtime.python, [runtime.bridge], {
      cwd: runtime.root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`AI Intelligence execution timed out after ${processTimeoutMs}ms`));
    }, processTimeoutMs);
    timer.unref?.();

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        fail(new Error("AI Intelligence execution exceeded the output limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      if (code !== 0) {
        fail(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              `AI Intelligence bridge exited with code ${code}`,
          ),
        );
        return;
      }
      try {
        const result = JSON.parse(
          Buffer.concat(stdout).toString("utf8"),
        ) as AiExecuteResult;
        settled = true;
        resolve(result);
      } catch (error) {
        fail(new Error(`Invalid AI Intelligence bridge response: ${String(error)}`));
      }
    });

    child.stdin.end(JSON.stringify(params));
  });
}
