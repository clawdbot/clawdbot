import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
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

type TargetInfo = { targetId: string; type: string; url: string };

export type PanelTarget = {
  allText: (selector: string) => Promise<string[]>;
  click: (selector: string) => Promise<void>;
  disabled: (selector: string) => Promise<boolean>;
  fill: (selector: string, value: string) => Promise<void>;
  hidden: (selector: string) => Promise<boolean>;
  pressEnter: (
    selector: string,
    isComposing: boolean,
  ) => Promise<{
    defaultPrevented: boolean;
    value: string;
  }>;
  screenshot: (targetPath: string) => Promise<void>;
  text: (selector: string) => Promise<string>;
  wakeBackground: () => Promise<void>;
};

export function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function countCopilotHistoryRequests(
  gateway: Pick<CopilotTurnIsolationGateway, "requests">,
): number {
  return gateway.requests.filter((request) => request.method === "chat.history").length;
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

  const historyRequestsBeforeStaleEvents = countCopilotHistoryRequests(gateway);
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
    .poll(() => countCopilotHistoryRequests(gateway), { timeout: 10_000 })
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

function isSidePanelTarget(target: { url: string }): boolean {
  try {
    return new URL(target.url).pathname.endsWith("/sidepanel.html");
  } catch {
    return false;
  }
}

function createPanelTarget(root: CDPSession, sessionId: string): PanelTarget {
  let commandId = 0;
  const pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (result: Record<string, unknown>) => void }
  >();
  root.on("Target.receivedMessageFromTarget", (event: { message: string; sessionId: string }) => {
    if (event.sessionId !== sessionId) {
      return;
    }
    const message = JSON.parse(event.message) as {
      error?: { message?: string };
      id?: number;
      result?: Record<string, unknown>;
    };
    if (typeof message.id !== "number") {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message ?? "CDP panel command failed"));
    } else {
      waiter.resolve(message.result ?? {});
    }
  });

  async function send(method: string, params: Record<string, unknown> = {}) {
    const id = ++commandId;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    await root.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    });
    return await result;
  }

  async function evaluate<T>(expression: string): Promise<T> {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const exception = result.exceptionDetails as { text?: string } | undefined;
    if (exception) {
      throw new Error(exception.text ?? "side-panel evaluation failed");
    }
    return (result.result as { value?: T } | undefined)?.value as T;
  }

  const selectorExpression = (selector: string) => JSON.stringify(selector);
  return {
    allText: async (selector) =>
      await evaluate<string[]>(
        `[...document.querySelectorAll(${selectorExpression(selector)})].map((node) => node.textContent ?? "")`,
      ),
    click: async (selector) => {
      await evaluate(`document.querySelector(${selectorExpression(selector)})?.click()`);
    },
    disabled: async (selector) =>
      await evaluate<boolean>(
        `Boolean(document.querySelector(${selectorExpression(selector)})?.disabled)`,
      ),
    fill: async (selector, value) => {
      await evaluate(`(() => {
        const input = document.querySelector(${selectorExpression(selector)});
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
    },
    hidden: async (selector) =>
      await evaluate<boolean>(
        `document.querySelector(${selectorExpression(selector)})?.classList.contains("hidden") === true`,
      ),
    pressEnter: async (selector, isComposing) =>
      await evaluate<{ defaultPrevented: boolean; value: string }>(`(() => {
        const input = document.querySelector(${selectorExpression(selector)});
        const event = new KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true, isComposing: ${isComposing},
        });
        input.dispatchEvent(event);
        return { defaultPrevented: event.defaultPrevented, value: input.value };
      })()`),
    screenshot: async (targetPath) => {
      await send("Page.enable");
      const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
      await fs.writeFile(targetPath, Buffer.from(String(result.data), "base64"));
    },
    text: async (selector) =>
      await evaluate<string>(
        `document.querySelector(${selectorExpression(selector)})?.textContent ?? ""`,
      ),
    wakeBackground: async () => {
      await evaluate(
        `chrome.runtime.sendMessage({ type: "copilot.e2e.wake" }).catch(() => undefined)`,
      );
    },
  };
}

export async function openTabPanel(params: {
  browserCdp: CDPSession;
  expect: typeof VitestExpect;
  extensionId: string;
  page: Page;
}): Promise<PanelTarget> {
  const prior = (await params.browserCdp.send("Target.getTargets")) as {
    targetInfos: TargetInfo[];
  };
  const priorTargetIds = new Set(prior.targetInfos.map((target) => target.targetId));
  await params.page.goto(`chrome-extension://${params.extensionId}/e2e-launcher.html`);
  await params.expect
    .poll(async () => await params.page.locator("body").getAttribute("data-ready"))
    .toBe("true");
  await params.page.locator("#open").click();
  await params.expect
    .poll(
      async () =>
        await params.page.locator("body").evaluate((body) => ({
          error: body.dataset.error,
          opened: body.dataset.opened,
        })),
      { timeout: 5_000 },
    )
    .toEqual({ error: undefined, opened: "true" });
  await params.expect
    .poll(
      async () => {
        const targets = (await params.browserCdp.send("Target.getTargets")) as {
          targetInfos: TargetInfo[];
        };
        return targets.targetInfos.find(
          (target) => !priorTargetIds.has(target.targetId) && isSidePanelTarget(target),
        );
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  const targets = (await params.browserCdp.send("Target.getTargets")) as {
    targetInfos: TargetInfo[];
  };
  const target = targets.targetInfos.find(
    (candidate) => !priorTargetIds.has(candidate.targetId) && isSidePanelTarget(candidate),
  );
  if (!target) {
    throw new Error("Chrome did not expose the tab-specific side-panel target");
  }
  const attached = (await params.browserCdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: false,
  })) as { sessionId: string };
  return createPanelTarget(params.browserCdp, attached.sessionId);
}

// Distro Chromium can omit the Extensions CDP domain these tests require.
// Honor an explicit compatible override; otherwise use Playwright's pinned build.
export async function resolveChromiumExecutableOverride(): Promise<string | undefined> {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (!override) {
    return undefined;
  }
  await fs.access(override);
  return override;
}

export async function waitForLoadedExtensionId(
  browserCdp: CDPSession,
  extensionPath: string,
): Promise<string> {
  const canonicalPath = async (candidate: string): Promise<string> => {
    try {
      return await fs.realpath(candidate);
    } catch {
      return path.resolve(candidate);
    }
  };
  const expectedPath = await canonicalPath(extensionPath);
  const deadline = Date.now() + 10_000;
  do {
    const result = (await browserCdp.send("Extensions.getExtensions")) as {
      extensions: Array<{ id: string; path: string }>;
    };
    for (const extension of result.extensions) {
      // macOS reports canonical /private paths even when the fixture was created through /tmp.
      if ((await canonicalPath(extension.path)) === expectedPath) {
        return extension.id;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  } while (Date.now() < deadline);
  throw new Error("Chromium did not report the loaded browser copilot extension");
}

export async function waitForContextExtensionId(
  context: BrowserContext,
  extensionPath: string,
): Promise<string> {
  const browser = context.browser();
  if (!browser) {
    throw new Error("Chromium browser connection unavailable");
  }
  return await waitForLoadedExtensionId(await browser.newBrowserCDPSession(), extensionPath);
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
