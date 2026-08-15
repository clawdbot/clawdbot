// Runs one package-installed OpenClaw turn with explicit message-tool-only
// source delivery so Codex exposes the progress/final control under test.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, sessionId, modelRef, timeoutSeconds, outputPath, prompt] =
  process.argv.slice(2);
if (!packageRoot || !sessionId || !modelRef || !timeoutSeconds || !outputPath || !prompt) {
  throw new Error(
    "usage: followthrough-turn.mjs <package-root> <session-id> <model-ref> <timeout-seconds> <output-path> <prompt>",
  );
}
if (!/^\d+$/u.test(timeoutSeconds) || Number(timeoutSeconds) < 1) {
  throw new Error(`invalid timeout seconds: ${timeoutSeconds}`);
}

const agentRuntimePath = path.join(
  path.resolve(packageRoot),
  "dist",
  "plugin-sdk",
  "agent-runtime.js",
);
const { agentCommandFromIngress } = await import(pathToFileURL(agentRuntimePath).href);
if (typeof agentCommandFromIngress !== "function") {
  throw new Error(
    `package agent runtime did not export agentCommandFromIngress: ${agentRuntimePath}`,
  );
}

const quietRuntime = {
  log: () => {},
  error: (...args) => console.error(...args),
  exit: (code) => {
    throw new Error(`agent runtime exited with code ${code}`);
  },
};
const result = await agentCommandFromIngress(
  {
    agentId: "main",
    sessionId,
    message: prompt,
    model: modelRef,
    thinking: "medium",
    timeout: timeoutSeconds,
    json: true,
    messageChannel: "webchat",
    channel: "webchat",
    sourceReplyDeliveryMode: "message_tool_only",
    senderIsOwner: true,
    allowModelOverride: true,
    // The embedded one-shot path retires bundled runtime resources; the Codex
    // harness uses this signal to close its shared app-server client and child.
    cleanupBundleMcpOnRunEnd: true,
    cleanupCliLiveSessionOnRunEnd: true,
    oneShotCliRun: true,
  },
  quietRuntime,
);
fs.writeFileSync(outputPath, `${JSON.stringify(result)}\n`);
