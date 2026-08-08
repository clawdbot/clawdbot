import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, CDPSession, Page } from "playwright-core";
import type { expect as VitestExpect } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import {
  computeRelayAuthProof,
  deriveRelayAuthKeyId,
  type RelayAuthProofFields,
} from "./modules/relay-auth-v2-crypto.js";

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

type RelayHarness = {
  readonly connectionCount: number;
  hellos: Array<Record<string, unknown>>;
  port: number;
  close: () => Promise<void>;
  command: (body: Record<string, unknown>) => Promise<unknown>;
  setAvailable: (available: boolean) => void;
};

export async function createRelayHarness(token = "a".repeat(64)): Promise<RelayHarness> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("extension relay test server did not bind a TCP port");
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1_000_000,
    handleProtocols: (protocols) =>
      protocols.has("openclaw-extension-relay.v2") ? "openclaw-extension-relay.v2" : false,
  });
  const hellos: Array<Record<string, unknown>> = [];
  const pendingCommands = new Map<
    number,
    { reject: (error: Error) => void; resolve: (result: unknown) => void }
  >();
  let available = true;
  let connectionCount = 0;
  let nextCommandSeq = 0;
  const authenticated = new Set<import("ws").WebSocket>();
  server.on("upgrade", (request, socket, head) => {
    if (!available) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });
  wss.on("connection", (socket) => {
    let authState:
      | { kind: "hello" }
      | {
          kind: "response";
          fields: RelayAuthProofFields;
          clientProof?: string;
        }
      | { kind: "authenticated" } = { kind: "hello" };
    const handleMessage = async (data: RawData) => {
      const message = JSON.parse(rawDataText(data)) as Record<string, unknown>;
      if (authState.kind === "hello") {
        if (
          message.type !== "auth.hello" ||
          message.v !== 2 ||
          typeof message.keyId !== "string" ||
          typeof message.clientNonce !== "string"
        ) {
          socket.close(4001, "expected auth.hello");
          return;
        }
        const keyId = await deriveRelayAuthKeyId(token);
        if (message.keyId !== keyId) {
          socket.close(4001, "keyId mismatch");
          return;
        }
        const issuedAtMs = Date.now();
        const fields: RelayAuthProofFields = {
          keyId,
          instanceId: randomBytes(16).toString("base64url"),
          sessionId: randomBytes(16).toString("base64url"),
          clientNonce: message.clientNonce,
          serverNonce: randomBytes(32).toString("base64url"),
          issuedAtMs,
          expiresAtMs: issuedAtMs + 10_000,
          role: "extension",
          transport: "websocket",
          method: "GET",
          resource: "/extension",
          flow: "extension",
        };
        authState = { kind: "response", fields };
        socket.send(
          JSON.stringify({
            type: "auth.challenge",
            v: 2,
            ...fields,
            serverProof: await computeRelayAuthProof(token, "server", fields),
          }),
        );
        return;
      }
      if (authState.kind === "response") {
        if (
          message.type !== "auth.response" ||
          message.v !== 2 ||
          message.sessionId !== authState.fields.sessionId ||
          typeof message.clientProof !== "string"
        ) {
          socket.close(4001, "expected auth.response");
          return;
        }
        const fields = authState.fields;
        const expectedClientProof = await computeRelayAuthProof(token, "client", fields);
        if (message.clientProof !== expectedClientProof) {
          socket.close(4001, "clientProof mismatch");
          return;
        }
        authState = { kind: "authenticated" };
        authenticated.add(socket);
        socket.send(
          JSON.stringify({
            type: "auth.ok",
            v: 2,
            sessionId: fields.sessionId,
            acceptProof: await computeRelayAuthProof(token, "accept", fields, message.clientProof),
          }),
        );
        return;
      }
      if (message.type === "hello") {
        connectionCount += 1;
        hellos.push(message);
        return;
      }
      const seq = typeof message.seq === "number" ? message.seq : undefined;
      if (seq === undefined || (message.type !== "result" && message.type !== "error")) {
        return;
      }
      const pending = pendingCommands.get(seq);
      if (!pending) {
        return;
      }
      pendingCommands.delete(seq);
      if (message.type === "error") {
        pending.reject(new Error(textValue(message.message) || "extension relay command failed"));
      } else {
        pending.resolve(message.result);
      }
    };
    socket.on("message", (data) => {
      void handleMessage(data);
    });
    socket.on("close", () => authenticated.delete(socket));
  });
  return {
    get connectionCount() {
      return connectionCount;
    },
    hellos,
    port: address.port,
    command: async (body) => {
      const client = [...authenticated].find((candidate) => candidate.readyState === 1);
      if (!client) {
        throw new Error("extension relay client is not connected");
      }
      const seq = ++nextCommandSeq;
      const result = new Promise<unknown>((resolve, reject) => {
        pendingCommands.set(seq, { resolve, reject });
      });
      client.send(JSON.stringify({ ...body, seq }));
      return await result;
    },
    setAvailable: (nextAvailable) => {
      available = nextAvailable;
      if (!available) {
        for (const client of wss.clients) {
          client.terminate();
        }
      }
    },
    close: async () => {
      for (const pending of pendingCommands.values()) {
        pending.reject(new Error("extension relay harness closed"));
      }
      pendingCommands.clear();
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
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
