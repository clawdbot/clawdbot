#!/usr/bin/env -S node --import tsx
/**
 * Live proof: real createBrowserTool().execute() screenshot catch + later snapshot
 * through the in-process browser control service (no vitest mocks).
 *
 * Run from repo root:
 *   pnpm exec tsx scripts/repro/browser-vision-failure-live-handler.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBrowserTool } from "../../extensions/browser/src/browser-tool.js";
import { getFreePort } from "../../extensions/browser/src/browser/test-port.js";
import {
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../extensions/browser/src/control-service.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/types.js";

type ToolResult = { content?: readonly unknown[]; details?: unknown } | undefined;

function contentBlockTypes(result: ToolResult): string[] {
  const content = result?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block) => {
    const type = (block as { type?: unknown }).type;
    return typeof type === "string" ? type : "unknown";
  });
}

function countImageBlocks(result: ToolResult): number {
  return contentBlockTypes(result).filter((type) => type === "image").length;
}

function resultText(result: ToolResult): string {
  const content = result?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        (block as { type?: unknown }).type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

function redactPaths(text: string): string {
  return text.replaceAll(os.homedir(), "[redacted-home]").replaceAll(os.tmpdir(), "[redacted-tmp]");
}

function renderResult(label: string, result: ToolResult): string {
  const lines = [
    `--- ${label} ---`,
    `content-block types: [${contentBlockTypes(result).join(", ")}]`,
    `image content blocks: ${countImageBlocks(result)}`,
    `text: ${redactPaths(resultText(result)).slice(0, 500)}`,
  ];
  const details = result?.details as
    | { vision?: { failed?: boolean; error?: string }; media?: unknown }
    | undefined;
  if (details?.vision?.failed) {
    lines.push(`details.vision.failed: true`);
    if (details.vision.error) {
      lines.push(`details.vision.error: ${redactPaths(details.vision.error)}`);
    }
  }
  if ("media" in (details ?? {})) {
    lines.push(`details.media: ${details?.media === undefined ? "undefined" : "present"}`);
  }
  return lines.join("\n");
}

function buildConfig(gatewayPort: number): OpenClawConfig {
  const chromePath =
    process.env.BROWSER_EXECUTABLE_PATH?.trim() ||
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome");
  return {
    gateway: { port: gatewayPort },
    browser: {
      enabled: true,
      headless: true,
      noSandbox: process.platform === "linux",
      defaultProfile: "openclaw",
      executablePath: chromePath,
      profiles: {
        openclaw: {
          cdpPort: gatewayPort + 11,
          color: "#FF4500",
        },
      },
    },
    tools: {
      media: {
        image: {
          models: [{ provider: "openai", model: "gpt-4o-mini" }],
        },
      },
    },
  };
}

const PROOF_PAGE_URL = "https://example.com/";

function readTargetId(result: ToolResult): string | undefined {
  const details = result?.details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const targetId = (details as { targetId?: unknown }).targetId;
  return typeof targetId === "string" ? targetId : undefined;
}

async function main(): Promise<void> {
  const gatewayPort = await getFreePort();
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-live-handler-proof-"));
  const cfg = buildConfig(gatewayPort);
  setRuntimeConfigSnapshot(cfg, cfg);

  try {
    const service = await startBrowserControlServiceFromConfig();
    if (!service) {
      throw new Error("browser control service failed to start");
    }

    const tool = createBrowserTool({
      allowHostControl: true,
      agentSessionKey: "agent:proof:live-handler",
      agentDir: stateRoot,
      workspaceDir: stateRoot,
      activeModel: { provider: "anthropic", model: "claude-sonnet-4.6" },
      mediaScope: { sessionKey: "agent:proof:live-handler", channel: "cli" },
    });

    console.log("=== Step 1: start browser (real browser control service) ===");
    await tool.execute?.("live-proof-start", {
      action: "start",
      target: "host",
      profile: "openclaw",
    });

    console.log("\n=== Step 2: open proof page (real browser control service) ===");
    const openResult = await tool.execute?.("live-proof-open", {
      action: "open",
      target: "host",
      profile: "openclaw",
      url: PROOF_PAGE_URL,
    });
    const targetId = readTargetId(openResult);
    console.log(`opened tab targetId: ${targetId ?? "(default)"}`);
    console.log(`proof page url: ${PROOF_PAGE_URL}`);

    console.log(
      "\n=== Step 3: screenshot via real createBrowserTool().execute() (configured vision fails) ===",
    );
    const screenshotResult = await tool.execute?.("live-proof-screenshot", {
      action: "screenshot",
      target: "host",
      profile: "openclaw",
      ...(targetId ? { targetId } : {}),
    });
    console.log(renderResult("real screenshot handler catch path", screenshotResult));

    console.log("\n=== Step 4: later snapshot in same session (real handler) ===");
    const snapshotResult = await tool.execute?.("live-proof-snapshot", {
      action: "snapshot",
      target: "host",
      profile: "openclaw",
      ...(targetId ? { targetId } : {}),
    });
    console.log(renderResult("real snapshot handler (later tool call)", snapshotResult));

    const screenshotImages = countImageBlocks(screenshotResult);
    const snapshotImages = countImageBlocks(snapshotResult);
    const visionFailed = Boolean(
      (screenshotResult?.details as { vision?: { failed?: boolean } } | undefined)?.vision?.failed,
    );
    const screenshotText = resultText(screenshotResult);
    const pass =
      screenshotImages === 0 &&
      snapshotImages === 0 &&
      visionFailed &&
      screenshotText.includes("browser screenshot vision failed");

    console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
    if (!pass) {
      process.exitCode = 1;
    }
  } finally {
    try {
      await stopBrowserControlService();
    } catch {
      // Best effort cleanup.
    }
    clearRuntimeConfigSnapshot();
    await rm(stateRoot, { recursive: true, force: true });
  }
}

await main();
