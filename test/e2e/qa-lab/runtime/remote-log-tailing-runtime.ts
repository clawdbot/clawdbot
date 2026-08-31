import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/remote-log-tailing-runtime.ts";

function artifactBase(argv: readonly string[]): string {
  const index = argv.indexOf("--artifact-base");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error("--artifact-base is required");
  }
  return path.resolve(value);
}

function logLine(message: string): string {
  return `${JSON.stringify({
    time: new Date().toISOString(),
    level: "info",
    subsystem: "qa-remote-logs",
    message,
  })}\n`;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      reject(new Error("follow child did not close before timeout"));
    }, timeoutMs);
    child.once("close", onClose);
  });
}

async function stopFollowChild(child: ChildProcess): Promise<void> {
  if (hasExited(child)) {
    return;
  }
  child.kill("SIGINT");
  try {
    await waitForClose(child, 5_000);
  } catch {
    if (hasExited(child)) {
      return;
    }
    child.kill("SIGKILL");
    await waitForClose(child, 5_000);
  }
}

export async function withOwnedFollowChild<T>(
  child: ChildProcess,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    await stopFollowChild(child);
  }
}

export async function runRemoteLogTailing(repoRoot: string, outputRoot: string) {
  const logPath = path.join(outputRoot, "gateway.jsonl");
  await mkdir(outputRoot, { recursive: true });
  const gatewayOwner = createQaGatewayChild();
  try {
    const gateway = await gatewayOwner.start({
      repoRoot,
      command: {
        executablePath: process.execPath,
        argsPrefix: [path.join(repoRoot, "dist", "index.js")],
        cwd: repoRoot,
        usePackagedPlugins: true,
      },
      transportBaseUrl: "http://127.0.0.1:9",
      controlUiEnabled: false,
      mutateConfig: (config) => ({
        ...config,
        logging: { ...config.logging, file: logPath, level: "info" },
      }),
    });
    await appendFile(logPath, logLine("qa-line-one"));
    await appendFile(logPath, logLine("qa-line-two"));
    await appendFile(logPath, logLine("qa-line-three"));

    const first = (await gateway.call("logs.tail", { limit: 2, maxBytes: 4096 })) as {
      cursor: number;
      lines: string[];
      truncated: boolean;
    };
    if (
      first.lines.length !== 2 ||
      !first.lines.some((line) => line.includes("qa-line-three")) ||
      !first.truncated
    ) {
      throw new Error(`logs.tail did not honor limit: ${JSON.stringify(first)}`);
    }
    const bounded = (await gateway.call("logs.tail", { limit: 20, maxBytes: 96 })) as {
      cursor: number;
      lines: string[];
      truncated: boolean;
    };
    if (!bounded.truncated || bounded.cursor <= 0) {
      throw new Error(`logs.tail did not honor maxBytes: ${JSON.stringify(bounded)}`);
    }
    await appendFile(logPath, logLine("qa-cursor-line"));
    const cursorTail = (await gateway.call("logs.tail", {
      cursor: first.cursor,
      limit: 20,
      maxBytes: 4096,
    })) as { lines: string[] };
    if (
      !cursorTail.lines.some((line) => line.includes("qa-cursor-line")) ||
      cursorTail.lines.some((line) => /qa-line-(?:one|two|three)/.test(line))
    ) {
      throw new Error(`logs.tail did not honor cursor: ${JSON.stringify(cursorTail)}`);
    }

    const cliJson = await gateway.runCli([
      "logs",
      "--url",
      gateway.wsUrl,
      "--token",
      gateway.token,
      "--json",
      "--limit",
      "200",
      "--max-bytes",
      "250000",
    ]);
    const cliRecords = cliJson
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; message?: string });
    if (!cliRecords.some((record) => record.type === "meta")) {
      throw new Error(`packaged logs CLI omitted metadata: ${cliJson}`);
    }
    if (!cliRecords.some((record) => record.message === "qa-cursor-line")) {
      throw new Error(`packaged logs CLI omitted the tailed record: ${cliJson}`);
    }

    const child = spawn(
      process.execPath,
      [
        path.join(repoRoot, "dist", "index.js"),
        "logs",
        "--url",
        gateway.wsUrl,
        "--token",
        gateway.token,
        "--json",
        "--follow",
        "--interval",
        "50",
        "--limit",
        "1",
        "--max-bytes",
        "4096",
      ],
      { cwd: repoRoot, env: gateway.runtimeEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const followOutput = await withOwnedFollowChild(child, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
      await appendFile(logPath, logLine("qa-follow-line"));
      const deadline = Date.now() + 10_000;
      while (!stdout.includes("qa-follow-line") && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      if (!stdout.includes("qa-follow-line")) {
        throw new Error(`follow did not receive appended record: ${stderr}`);
      }
      return stdout;
    });
    return { first, bounded, cursorTail, cliRecords, followOutput };
  } finally {
    await stopQaGatewayFixture(gatewayOwner);
  }
}

async function main() {
  const repoRoot = process.cwd();
  const outputRoot = artifactBase(process.argv.slice(2));
  const startedAt = Date.now();
  const writer = createQaScriptEvidenceWriter({
    artifactBase: outputRoot,
    logFileName: "remote-log-tailing.log",
    primaryModel: "none",
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: "remote-log-tailing",
      sourcePath: "qa/scenarios/cli/remote-log-tailing.yaml",
      title: "Remote gateway log tailing",
      codeRefs: [SOURCE_PATH, "src/cli/logs-cli.ts", "src/gateway/server-methods/logs.ts"],
    },
  });
  try {
    const result = await runRemoteLogTailing(repoRoot, outputRoot);
    writer.appendLog(`${JSON.stringify(result)}\n`);
    await writer.write({ durationMs: Date.now() - startedAt, status: "pass" });
  } catch (error) {
    writer.appendLog(`${String(error)}\n`);
    await writer.write({
      details: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
      status: "fail",
    });
    throw error;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await main();
}
