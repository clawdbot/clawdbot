import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Page } from "playwright";
import { expect } from "vitest";
import { SESSION_DRAG_MIME } from "../lib/sessions/drag.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export {
  expectDefined,
  SESSION_DRAG_MIME,
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
};

export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

export async function captureUiProof(
  owner: { readonly artifactDir: string },
  page: Page,
  directory: string,
  fileName: string,
): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  const artifactDir = path.join(owner.artifactDir, directory);
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(artifactDir, fileName),
  });
}

export function createChatFlowE2eSuite() {
  return createControlUiE2eSuite({
    name: "Control UI mocked Gateway E2E",
    trackBrowserContexts: true,
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

export async function buildLocalWebchatAudioMessage(source: string) {
  const { buildWebchatAssistantMessageFromReplyPayloads } =
    await import("../../../src/gateway/server-methods/chat-webchat-media.ts");
  const audioPath = new URL(source).pathname;
  const localRoot = path.dirname(audioPath);
  await mkdir(localRoot, { recursive: true });
  await writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  return expectDefined(
    await buildWebchatAssistantMessageFromReplyPayloads(
      [{ mediaUrl: source, trustedLocalMedia: true }],
      { localRoots: [localRoot] },
    ),
    "Gateway-produced WebChat audio message",
  );
}

export const requireRecord = createRequireRecord("record", "expected-object-value");

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected non-empty ${label}`);
  }
  return value;
}

export async function waitForRequests(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  method: string,
  count: number,
): Promise<MockGatewayRequest[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests(method);
    if (requests.length >= count) {
      return requests;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for ${count} ${method} requests`);
}

export async function expectRequestCountStable(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  method: string,
  count: number,
  durationMs = 500,
): Promise<void> {
  const deadline = Date.now() + durationMs;
  do {
    expect(await gateway.getRequests(method)).toHaveLength(count);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  } while (Date.now() < deadline);
}

export async function installPlainHttpClipboardCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec = [];
    document.execCommand = ((command: string) => {
      if (command !== "copy") {
        return false;
      }
      const active = document.activeElement as HTMLTextAreaElement | null;
      (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec.push(
        active?.value ?? "",
      );
      return true;
    }) as typeof document.execCommand;
  });
}

export async function copiedViaExec(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as unknown as { copiedViaExec: string[] }).copiedViaExec);
}

export async function chatThreadDistanceFromBottom(page: Page): Promise<number> {
  return page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    return Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight);
  });
}

export async function waitForChatScrollIdle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate(async (element) => {
          const thread = element as HTMLElement;
          const readGeometry = () => ({
            clientHeight: thread.clientHeight,
            scrollHeight: thread.scrollHeight,
            scrollTop: Math.round(thread.scrollTop),
          });
          const before = readGeometry();
          await new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, 180);
          });
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          });
          const after = readGeometry();
          return (
            before.clientHeight === after.clientHeight &&
            before.scrollHeight === after.scrollHeight &&
            before.scrollTop === after.scrollTop
          );
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
}

export async function scrollChatThreadToTop(page: Page): Promise<void> {
  await page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    thread.scrollTop = 0;
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
}

export async function captureSessionAccessibilityProof(
  owner: { readonly artifactDir: string },
  page: Page,
  name: string,
): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  const sessionAccessibilityProofDir = path.join(owner.artifactDir, "session-accessibility");
  const sidebar = page.locator("openclaw-app-sidebar");
  await page.screenshot({
    fullPage: true,
    path: path.join(sessionAccessibilityProofDir, `${name}.png`),
  });
  await writeFile(
    path.join(sessionAccessibilityProofDir, `${name}.yml`),
    await sidebar.ariaSnapshot(),
    "utf8",
  );
}

export async function visibleChatBubbleTexts(page: Page): Promise<string[]> {
  return page.locator(".chat-pane-cache__pane--active .chat-thread").evaluate((element) => {
    const thread = element as HTMLElement;
    const viewport = thread.getBoundingClientRect();
    return Array.from(thread.querySelectorAll(".chat-bubble"))
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return (
          rect.height > 0 &&
          rect.width > 0 &&
          rect.bottom > viewport.top &&
          rect.top < viewport.bottom
        );
      })
      .map((candidate) => candidate.textContent?.trim() ?? "")
      .filter(Boolean);
  });
}

export function chatSessionListResponse(
  sessions: Array<
    Record<string, unknown> & {
      key: string;
      kind: string;
      label: string;
      updatedAt: number;
    }
  > = [
    { key: "agent:main:session-a", kind: "direct", label: "Session A", updatedAt: 2 },
    { key: "agent:main:session-b", kind: "direct", label: "Session B", updatedAt: 1 },
  ],
) {
  return {
    count: sessions.length,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions,
    ts: Date.now(),
  };
}

export async function sidebarSessionOrder(page: Page): Promise<string[]> {
  return page
    .locator(".sidebar-recent-session")
    .evaluateAll((rows) =>
      rows
        .map((row) => row.getAttribute("data-session-key") ?? "")
        .filter((key) => key.startsWith("agent:main:session-")),
    );
}

/** Read native queued Blobs without going through a credential-filtered UI projection. */
export async function readOutboxPayloadAttachments(page: Page, key: string) {
  return page.evaluate(async (payloadKey) => {
    type StoredPayload = {
      attachments: Array<{ blob: Blob; fileName?: string; mimeType: string }>;
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("openclaw-control-ui");
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener(
        "error",
        () => reject(request.error ?? new Error("IDB open failed")),
        { once: true },
      );
    });
    try {
      const payload = await new Promise<StoredPayload | undefined>((resolve, reject) => {
        const request = database
          .transaction("outboxPayloads")
          .objectStore("outboxPayloads")
          .get(payloadKey);
        request.addEventListener(
          "success",
          () => resolve(request.result as StoredPayload | undefined),
          { once: true },
        );
        request.addEventListener(
          "error",
          () => reject(request.error ?? new Error("IDB read failed")),
          { once: true },
        );
      });
      return payload
        ? Promise.all(
            payload.attachments.map(async ({ blob, fileName, mimeType }) => {
              let binary = "";
              for (const byte of new Uint8Array(await blob.arrayBuffer())) {
                binary += String.fromCharCode(byte);
              }
              return { fileName, mimeType, base64: btoa(binary) };
            }),
          )
        : null;
    } finally {
      database.close();
    }
  }, key);
}
