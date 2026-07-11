// QA Lab producer exercises Voice Call CLI, Gateway RPC/tool, webhook, and realtime consult.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { WebSocket } from "ws";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/src/evidence-summary.js";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/src/gateway-child.js";
import { startQaMockOpenAiServer } from "../../../../extensions/qa-lab/src/providers/mock-openai/server.js";
import { getFreePort } from "../../../../src/test-utils/ports.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.js";

const FIXTURE_PLUGIN_ID = "qa-voice-call-runtime";
const FIXTURE_REALTIME_PROVIDER_ID = "qa-voice-call-realtime";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/voice-call-gateway.ts";

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type ProofResult = {
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

function parseOptions(argv: readonly string[]): ProducerOptions {
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const artifactBase = readValue("--artifact-base");
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return {
    artifactBase: path.resolve(artifactBase),
    repoRoot: path.resolve(readValue("--repo-root") ?? process.cwd()),
  };
}

function createFixturePlugin(repoRoot: string, outputRoot: string) {
  return {
    pluginDir: path.join(repoRoot, "test/e2e/qa-lab/runtime/fixtures/voice-call-runtime-plugin"),
    bridgeCallsPath: path.join(outputRoot, "bridge-calls.jsonl"),
    toolResultsPath: path.join(outputRoot, "tool-results.jsonl"),
  };
}

function withVoiceCallConfig(params: {
  config: OpenClawConfig;
  pluginDir: string;
  servePort: number;
}): OpenClawConfig {
  const config = params.config;
  return {
    ...config,
    plugins: {
      ...config.plugins,
      enabled: true,
      allow: [...new Set([...(config.plugins?.allow ?? []), "voice-call", FIXTURE_PLUGIN_ID])],
      load: {
        ...config.plugins?.load,
        paths: [...new Set([...(config.plugins?.load?.paths ?? []), params.pluginDir])],
      },
      entries: {
        ...config.plugins?.entries,
        "voice-call": {
          enabled: true,
          config: {
            enabled: true,
            provider: "mock",
            inboundPolicy: "open",
            maxConcurrentCalls: 4,
            serve: { port: params.servePort, bind: "127.0.0.1", path: "/voice/webhook" },
            realtime: {
              enabled: true,
              provider: FIXTURE_REALTIME_PROVIDER_ID,
              streamPath: "/voice/stream/realtime",
              toolPolicy: "safe-read-only",
              consultPolicy: "auto",
              providers: { [FIXTURE_REALTIME_PROVIDER_ID]: {} },
            },
          },
        },
        [FIXTURE_PLUGIN_ID]: { enabled: true },
      },
    },
  };
}

function findStringByKey(value: unknown, key: string): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStringByKey(entry, key);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") {
    return record[key];
  }
  for (const entry of Object.values(record)) {
    const found = findStringByKey(entry, key);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function waitForFinalToolResult(filePath: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const entries = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const final = entries.find(
      (entry) =>
        entry.callId === "qa-consult-call" &&
        entry.options === undefined &&
        entry.result &&
        typeof entry.result === "object" &&
        !Object.hasOwn(entry.result, "status"),
    );
    if (final) {
      return { entries, final };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for final Voice Call consult tool result");
}

async function openRealtimeMediaStream(params: {
  providerCallId: string;
  servePort: number;
  streamUrl: string;
}) {
  const streamPath = new URL(params.streamUrl).pathname;
  const ws = new WebSocket(`ws://127.0.0.1:${params.servePort}${streamPath}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify({
      event: "start",
      start: { streamSid: "MZ-qa-voice-call", callSid: params.providerCallId },
    }),
  );
  return ws;
}

async function runVoiceCallProof(options: ProducerOptions): Promise<string> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-call-gateway-"));
  const fixture = createFixturePlugin(options.repoRoot, fixtureRoot);
  const mock = await startQaMockOpenAiServer();
  const servePort = await getFreePort();
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  let mediaStream: WebSocket | undefined;
  try {
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      enabledPluginIds: ["voice-call"],
      runtimeEnvPatch: {
        OPENCLAW_QA_VOICE_BRIDGE_CALLS_PATH: fixture.bridgeCallsPath,
        OPENCLAW_QA_VOICE_TOOL_RESULTS_PATH: fixture.toolResultsPath,
      },
      mutateConfig: (config) =>
        withVoiceCallConfig({ config, pluginDir: fixture.pluginDir, servePort }),
    });
    const cliOutput = await gateway.runCli([
      "voicecall",
      "start",
      "--to",
      "+15550001111",
      "--message",
      "CLI fixture",
      "--mode",
      "conversation",
    ]);
    const cliCallId = findStringByKey(JSON.parse(cliOutput), "callId");
    if (!cliCallId) {
      throw new Error(`Voice Call CLI did not return a callId: ${cliOutput}`);
    }
    const rpc = await gateway.call("voicecall.initiate", {
      to: "+15550002222",
      message: "Gateway RPC fixture",
      mode: "conversation",
      sessionKey: "agent:main:voice-rpc",
    });
    const rpcCallId = findStringByKey(rpc, "callId");
    if (!rpcCallId) {
      throw new Error(`voicecall.initiate did not return a callId: ${JSON.stringify(rpc)}`);
    }
    const tool = await gateway.call("tools.invoke", {
      name: "voice_call",
      sessionKey: "agent:main:requester",
      args: {
        action: "initiate_call",
        to: "+15550003333",
        message: "Agent tool fixture",
        mode: "conversation",
        sessionKey: "agent:main:voice-consult",
        requesterSessionKey: "agent:main:requester",
      },
    });
    const toolCallId = findStringByKey(tool, "callId");
    if (!toolCallId) {
      throw new Error(`tools.invoke voice_call did not return a callId: ${JSON.stringify(tool)}`);
    }
    const status = (await gateway.call("voicecall.status", {})) as {
      calls?: Array<{ providerCallId?: string }>;
    };
    if (!Array.isArray(status.calls) || status.calls.length !== 3) {
      throw new Error(
        `Voice Call status did not report all three calls: ${JSON.stringify(status)}`,
      );
    }
    const providerCallIds = status.calls.map((call) => call.providerCallId);
    if (providerCallIds.some((callId) => !callId?.startsWith("mock-"))) {
      throw new Error(
        `Voice Call entries did not use the mock provider: ${JSON.stringify(status)}`,
      );
    }
    const stream = (await gateway.call("qa.voiceCall.streamSession", {
      callId: toolCallId,
    })) as { providerCallId?: string; streamUrl?: string };
    if (!stream.providerCallId || !stream.streamUrl) {
      throw new Error(`Voice Call stream issuer returned invalid data: ${JSON.stringify(stream)}`);
    }
    mediaStream = await openRealtimeMediaStream({
      providerCallId: stream.providerCallId,
      servePort,
      streamUrl: stream.streamUrl,
    });
    const toolResults = await waitForFinalToolResult(fixture.toolResultsPath);
    const bridgeCalls = (await fs.readFile(fixture.bridgeCallsPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { tools?: string[] });
    if (!bridgeCalls.some((call) => call.tools?.includes("openclaw_agent_consult"))) {
      throw new Error(
        `realtime bridge did not expose embedded consult: ${JSON.stringify(bridgeCalls)}`,
      );
    }
    const requests = (await fetch(`${mock.baseUrl}/debug/requests`).then((response) =>
      response.json(),
    )) as Array<{ allInputText?: string; instructions?: string }>;
    const consultRequest = requests.find((request) =>
      request.allInputText?.includes("VOICE-CONSULT-42"),
    );
    if (!consultRequest) {
      throw new Error(
        `embedded consult request did not include provider context: ${JSON.stringify(requests)}`,
      );
    }
    const promptText = `${consultRequest.instructions ?? ""}\n${consultRequest.allInputText ?? ""}`;
    for (const marker of [
      "live phone call",
      "Caller partial transcript context",
      "VOICE-CONSULT-42",
      "Use the embedded agent context",
    ]) {
      if (!promptText.includes(marker)) {
        throw new Error(`embedded consult prompt missed ${marker}: ${promptText}`);
      }
    }
    return `real CLI, voicecall.initiate, and tools.invoke created ${status.calls.length} mock-provider calls; runtime-issued media stream invoked embedded consult with transcript/provider context; tool results=${toolResults.entries.length}`;
  } finally {
    if (mediaStream && mediaStream.readyState < WebSocket.CLOSING) {
      mediaStream.close();
    }
    await gateway?.stop().catch(() => undefined);
    await mock.stop();
    await fs.rm(fixtureRoot, { force: true, recursive: true });
  }
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    return {
      details: await runVoiceCallProof(options),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    };
  } catch (error) {
    return {
      details: formatErrorMessage(error),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    };
  }
}

async function runVoiceCallGatewayProducer(
  options: ProducerOptions,
): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "voice-call-cli-rpc-agent-tool.log",
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: "voice-call-cli-rpc-agent-tool",
      title: "Voice Call CLI, RPC, and agent tool flow",
      sourcePath: "qa/scenarios/plugins/voice-call-cli-rpc-agent-tool.yaml",
      primaryCoverageIds: ["voice-call.cli-rpc-agent-tool"],
      docsRefs: ["docs/cli/voicecall.md", "docs/plugins/voice-call.md"],
      codeRefs: [
        SOURCE_PATH,
        "extensions/voice-call/index.ts",
        "extensions/voice-call/src/runtime.ts",
        "extensions/voice-call/src/webhook/realtime-handler.ts",
      ],
    },
  });
  const result = await produceProof(options);
  writer.appendLog(`${result.status}: ${result.details ?? "no details"}\n`);
  return await writer.write(result);
}

async function main(argv: readonly string[]) {
  const options = parseOptions(argv);
  const evidence = await runVoiceCallGatewayProducer(options);
  const status = evidence.entries[0]?.result.status;
  console.log(`Voice Call Gateway evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Voice Call Gateway status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
