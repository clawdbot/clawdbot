#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const RESULT_PREFIX = "OPENCLAW_ONBOARDING_E2E_RESULT=";
const APP_PATH = path.resolve(
  process.env.OPENCLAW_MACOS_E2E_APP_PATH ?? "dist/OpenClaw.app",
);
const APP_BINARY = path.join(APP_PATH, "Contents", "MacOS", "OpenClaw");
const APP_TIMEOUT_MS = 120_000;

const profile = `onboarde2e${process.env.GITHUB_RUN_ID ?? "local"}${randomBytes(3).toString("hex")}`
  .toLowerCase()
  .slice(0, 64);
const stateDir = path.join(os.homedir(), `.openclaw-${profile}`);
const workspaceDir = path.join(stateDir, "workspace");
const defaultsDomain = `ai.openclaw.mac.profile.${profile}`;

let app;
let mock;

try {
  await fs.access(APP_BINARY, fs.constants.X_OK);
  mock = await startMockOpenAI();
  await prepareFreshProfile(mock.baseUrl);

  const startedAt = Date.now();
  const result = await launchApp();
  const elapsedMs = Date.now() - startedAt;

  if (result.exitCode !== 0) {
    throw new Error(
      `OpenClaw.app exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const resultLine = result.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith(RESULT_PREFIX));
  if (!resultLine) {
    throw new Error(`OpenClaw.app did not emit an onboarding result\nstdout:\n${result.stdout}`);
  }
  const appResult = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
  if (appResult.status !== "passed") {
    throw new Error(`Onboarding failed: ${JSON.stringify(appResult)}`);
  }
  if (mock.requests.length < 1) {
    throw new Error("Onboarding completed without sending a request to the mock provider");
  }

  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      profile,
      elapsedMs,
      providerRequests: mock.requests.length,
      app: appResult,
    })}\n`,
  );
} finally {
  app?.kill("SIGTERM");
  await mock?.close();
  await cleanupProfile();
}

async function prepareFreshProfile(baseUrl) {
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, ".env"), "OPENAI_API_KEY=openclaw-e2e-key\n", {
    mode: 0o600,
  });
  await fs.writeFile(
    path.join(stateDir, "openclaw.json"),
    `${JSON.stringify(
      {
        gateway: { mode: "local" },
        plugins: { slots: { memory: "none" } },
        agents: {
          defaults: {
            workspace: workspaceDir,
            skipBootstrap: true,
            skills: [],
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          mode: "replace",
          providers: {
            openai: {
              baseUrl: `${baseUrl}/v1`,
              apiKey: "OPENAI_API_KEY",
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [
                {
                  id: "gpt-5.6-sol",
                  name: "OpenClaw onboarding E2E mock",
                  api: "openai-responses",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 272000,
                  maxTokens: 128000,
                },
              ],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function launchApp() {
  const env = stripCredentialEnvironment(process.env);
  env.OPENCLAW_PROFILE = profile;
  const child = spawn(APP_BINARY, ["--background-only", "--onboarding-e2e"], {
    cwd: path.dirname(APP_BINARY),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  app = child;
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`OpenClaw.app onboarding timed out after ${APP_TIMEOUT_MS}ms`));
    }, APP_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      app = undefined;
      resolve({ exitCode: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}

function stripCredentialEnvironment(source) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (/(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS|_PRIVATE_KEY)$/u.test(key)) continue;
    env[key] = value;
  }
  return env;
}

async function cleanupProfile() {
  const managedCLI = path.join(stateDir, "bin", "openclaw");
  try {
    await run(managedCLI, ["--profile", profile, "gateway", "uninstall"]);
  } catch {
    await run("launchctl", ["bootout", `gui/${process.getuid()}`, `ai.openclaw.${profile}`]).catch(
      () => undefined,
    );
  }
  await run("defaults", ["delete", defaultsDomain]).catch(() => undefined);
  await fs.rm(stateDir, { recursive: true, force: true });
}

async function run(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

async function startMockOpenAI() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(body);
    writeMockOpenAIResponse(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function writeMockOpenAIResponse(response) {
  const text = "OK";
  const message = {
    type: "message",
    id: "macos-onboarding-e2e-message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: "macos-onboarding-e2e-response",
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}
