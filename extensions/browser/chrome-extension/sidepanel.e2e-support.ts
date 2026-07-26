import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { expect as VitestExpect } from "vitest";
import type { RawData } from "ws";

type CopilotTurnIsolationGateway = {
  chatSends: Array<Record<string, unknown>>;
  requests: Array<{ method: string }>;
  emitEvent: (event: string, payload: Record<string, unknown>) => void;
};

type CopilotTurnIsolationPanel = {
  allText: (selector: string) => Promise<string[]>;
  click: (selector: string) => Promise<void>;
  disabled: (selector: string) => Promise<boolean>;
  fill: (selector: string, value: string) => Promise<void>;
};

export function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function rawDataText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return data instanceof ArrayBuffer
    ? Buffer.from(new Uint8Array(data)).toString("utf8")
    : data.toString("utf8");
}

export async function assertCopilotStaleRunIsolation(params: {
  expect: typeof VitestExpect;
  gateway: CopilotTurnIsolationGateway;
  panel: CopilotTurnIsolationPanel;
}): Promise<void> {
  const { expect, gateway, panel } = params;
  const initialSendCount = gateway.chatSends.length;

  await panel.fill("#message-input", "completed turn marker");
  await panel.click("#send-button");
  await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(initialSendCount + 1);
  await expect
    .poll(() => panel.allText(".message.assistant"), { timeout: 10_000 })
    .toContain("Isolated reply: completed turn marker");
  await expect.poll(() => panel.disabled("#message-input"), { timeout: 10_000 }).toBe(false);

  const completedRun = gateway.chatSends[initialSendCount];
  const completedRunId = textValue(completedRun?.idempotencyKey);
  const sessionKey = textValue(completedRun?.sessionKey);
  expect(completedRunId).not.toBe("");
  expect(sessionKey).not.toBe("");
  const originalAssistantMessages = await panel.allText(".message.assistant");
  const originalSystemMessages = await panel.allText(".message.system");

  await panel.fill("#message-input", "active turn linger marker");
  await panel.click("#send-button");
  await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(initialSendCount + 2);
  const activeRun = gateway.chatSends[initialSendCount + 1];
  const activeRunId = textValue(activeRun?.idempotencyKey);
  expect(activeRunId).not.toBe("");
  expect(activeRunId).not.toBe(completedRunId);
  expect(await panel.disabled("#message-input")).toBe(true);

  const historyRequestsBeforeStaleEvents = gateway.requests.filter(
    (request) => request.method === "chat.history",
  ).length;
  gateway.emitEvent("chat", {
    sessionKey,
    runId: completedRunId,
    state: "delta",
    deltaText: "Stale text from the completed turn",
  });
  gateway.emitEvent("chat", {
    sessionKey,
    runId: completedRunId,
    state: "error",
    errorMessage: "Stale error from the completed turn",
  });
  gateway.emitEvent("chat", { sessionKey, runId: completedRunId, state: "aborted" });
  gateway.emitEvent("chat", { sessionKey, runId: completedRunId, state: "final" });
  // The ordered history event proves preceding stale frames were consumed
  // before checking that the active run still owns the composer.
  gateway.emitEvent("session.message", { sessionKey });
  await expect
    .poll(() => gateway.requests.filter((request) => request.method === "chat.history").length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(historyRequestsBeforeStaleEvents);
  expect(await panel.disabled("#message-input")).toBe(true);
  expect(await panel.allText(".message.assistant")).toEqual(originalAssistantMessages);
  expect(await panel.allText(".message.system")).toEqual(originalSystemMessages);

  gateway.emitEvent("chat", {
    sessionKey,
    runId: activeRunId,
    state: "delta",
    deltaText: "Current turn remains live",
  });
  await expect
    .poll(() => panel.allText(".message.assistant"), { timeout: 10_000 })
    .toEqual([...originalAssistantMessages, "Current turn remains live"]);
  gateway.emitEvent("chat", { sessionKey, runId: activeRunId, state: "final" });
  await expect.poll(() => panel.disabled("#message-input"), { timeout: 10_000 }).toBe(false);

  await panel.fill("#message-input", "next normal turn marker");
  await panel.click("#send-button");
  await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(initialSendCount + 3);
  await expect
    .poll(() => panel.allText(".message.assistant"), { timeout: 10_000 })
    .toContain("Isolated reply: next normal turn marker");
}

export function isSidePanelTarget(target: { url: string }): boolean {
  try {
    return new URL(target.url).pathname.endsWith("/sidepanel.html");
  } catch {
    return false;
  }
}

export async function resolveChromiumExecutable(): Promise<string | undefined> {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const candidates = [override, "/usr/bin/chromium-browser", "/usr/bin/chromium"].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to Playwright's managed Chromium.
    }
  }
  return undefined;
}

export async function copyCopilotSidepanelExtension(tempDirs: {
  make: (prefix: string) => string;
}): Promise<string> {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const target = tempDirs.make("openclaw-copilot-extension-");
  await fs.cp(extensionDir, target, {
    recursive: true,
    filter: (source) => !source.endsWith(".test.ts"),
  });
  await fs.writeFile(
    path.join(target, "e2e-launcher.html"),
    '<!doctype html><button id="open">Open tab panel</button><script type="module" src="e2e-launcher.js"></script>',
  );
  await fs.writeFile(
    path.join(target, "e2e-launcher.js"),
    `const tab = await chrome.tabs.getCurrent();
    const panel = await chrome.runtime.sendMessage({ type: "prepareCopilotPanel", tabId: tab.id });
    if (!panel?.ok) throw new Error(panel?.error ?? "panel prepare failed");
    document.body.dataset.ready = "true";
    document.querySelector("#open").addEventListener("click", async () => {
      try {
        await chrome.sidePanel.setOptions({ tabId: tab.id, path: panel.path, enabled: true });
        await chrome.sidePanel.open({ tabId: tab.id });
        document.body.dataset.opened = "true";
      } catch (error) {
        document.body.dataset.error = error instanceof Error ? error.message : String(error);
      }
    });\n`,
  );
  return target;
}
