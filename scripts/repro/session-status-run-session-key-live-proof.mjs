#!/usr/bin/env node
/**
 * Live repro for implicit session_status + runSessionKey (#82669 / PR #82696).
 * Run: pnpm exec tsx scripts/repro/session-status-run-session-key-live-proof.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-status-proof-"));
const configPath = path.join(tmpRoot, "openclaw.json");
const storePath = path.join(tmpRoot, "sessions.json");
const store = {
  "agent:main:telegram:default:direct:1234": {
    sessionId: "s-tg-direct",
    updatedAt: 5,
    status: "done",
    thinkingLevel: "off",
  },
  "agent:main:main": {
    sessionId: "s-main",
    updatedAt: 10,
    status: "running",
    thinkingLevel: "high",
  },
};
fs.writeFileSync(configPath, "{}\n");
fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
process.env.OPENCLAW_CONFIG_PATH = configPath;
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";

const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, callback) => {
  const text = String(chunk);
  if (text.includes("gateway connect failed:")) {
    if (typeof encoding === "function") {
      encoding();
    } else if (typeof callback === "function") {
      callback();
    }
    return true;
  }
  return originalStderrWrite(chunk, encoding, callback);
};

const { createSessionStatusTool } = await import("../../src/agents/tools/session-status-tool.ts");

const config = {
  session: { mainKey: "main", scope: "per-sender", store: storePath },
  agents: {
    defaults: {
      model: { primary: "proof/gpt-5.4" },
      models: {},
    },
  },
  tools: {
    agentToAgent: { enabled: false },
  },
};

try {
  const tool = createSessionStatusTool({
    agentSessionKey: "agent:main:telegram:default:direct:1234",
    runSessionKey: "agent:main:main",
    config,
  });

  const result = await tool.execute("live-proof-implicit-run-session", {});
  const text =
    typeof result === "string"
      ? result
      : (result.content.find((item) => item.type === "text")?.text ?? result.details.statusText);
  const thinkingMatch = text.match(/\bThink:\s+(\w+)/i);
  const sessionKey = typeof result === "string" ? undefined : result.details.sessionKey;

  if (sessionKey !== "agent:main:main") {
    throw new Error(`expected details.sessionKey agent:main:main, got ${String(sessionKey)}`);
  }
  if (thinkingMatch?.[1] !== "high") {
    throw new Error(`expected status text to mention Think: high, got ${thinkingMatch?.[1]}`);
  }

  console.log(
    "implicit session_status resolved thinkingLevel from store =",
    store["agent:main:main"].thinkingLevel,
  );
  console.log("status text mentions thinking:", thinkingMatch[1]);
  console.log("details.sessionKey =", sessionKey);
  console.log("--- status excerpt ---");
  console.log(text.split("\n").slice(0, 8).join("\n"));
} finally {
  process.stderr.write = originalStderrWrite;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
