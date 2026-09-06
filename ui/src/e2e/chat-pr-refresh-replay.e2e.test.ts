import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
let browser: Browser;
let server: ControlUiE2eServer;

describe("PR refresh replay through the Control UI", () => {
  beforeAll(async () => {
    if (!canRunPlaywrightChromium(executablePath)) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    browser = await chromium.launch({ executablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("refreshes the first stream and distinct finals without replaying a completed refresh", async () => {
    const artifacts = createControlUiE2eArtifactDir("pr-refresh-replay");
    const viewport = { width: 1180, height: 800 };
    const context = await browser.newContext({
      viewport,
      recordVideo: { dir: artifacts, size: viewport },
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    try {
      const gateway = await installMockGateway(page, {
        assistantName: "Review fixture",
        agentModel: "openai/gpt-5.6-sol",
        models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" }],
        presenceUsers: [{ id: "synthetic-reviewer", name: "Synthetic Reviewer", self: true }],
        featureMethods: ["chat.metadata", "chat.startup", SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD],
        methodResponses: { [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true } },
      });
      await page.goto(`${server.baseUrl}chat`);
      const key = await waitForWatchedSessionKey(gateway);
      const pullRequest = {
        number: 111532,
        owner: "openclaw",
        repo: "openclaw",
        branch: "fixture/review-refresh",
        title: "Synthetic review refresh proof",
        url: "https://github.com/openclaw/openclaw/pull/111532",
        state: "open",
      };
      const snapshot = async (state: string) => {
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [key]: { pullRequests: [{ ...pullRequest, state }], rateLimited: false, status: "ok" },
          },
        });
        await expect
          .poll(() => page.locator(".chat-pr").first().getAttribute("data-state"))
          .toBe(state);
      };
      await snapshot("open");
      const forceRequests = async () =>
        (await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD)).filter((request) => {
          const params = request.params as { refreshSessionKeys?: string[] } | undefined;
          return params?.refreshSessionKeys?.includes(key);
        });
      const initialForces = (await forceRequests()).length;
      await writeFile(
        path.join(artifacts, "initial.png"),
        await takeControlUiViewportScreenshot(page, page.locator("body"), [
          page.locator(".chat-pr").first(),
        ]),
      );
      const runId = "synthetic-pr-review-run";
      const text = `Opened ${pullRequest.url}`;
      await gateway.emitGatewayEvent("chat", {
        sessionKey: key,
        runId,
        state: "delta",
        deltaText: text,
      });
      await expect.poll(async () => (await forceRequests()).length).toBe(initialForces + 1);
      const final = {
        sessionKey: key,
        runId,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text }] },
      };
      await gateway.emitGatewayEvent("chat", final);
      await expect.poll(async () => (await forceRequests()).length).toBe(initialForces + 2);
      // The next frame cannot share the earlier request's microtask batch.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      await gateway.emitGatewayEvent("chat", final);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      const afterReplay = (await forceRequests()).length - initialForces;
      const mergedText = `Merged ${pullRequest.url}`;
      await gateway.emitGatewayEvent("chat", {
        ...final,
        message: { role: "assistant", content: [{ type: "text", text: mergedText }] },
      });
      // A distinct final is a positive delivery barrier after the replay.
      await expect
        .poll(async () => (await forceRequests()).length)
        .toBe(initialForces + afterReplay + 1);
      await snapshot("merged");
      await page.getByText(mergedText, { exact: false }).first().waitFor();
      const requests = (await forceRequests()).slice(initialForces);
      await writeFile(
        path.join(artifacts, "wire.json"),
        JSON.stringify(
          { initialForces, afterReplay, forcedRefreshes: requests.length, requests },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(artifacts, "result.png"),
        await takeControlUiViewportScreenshot(page, page.locator("body"), [
          page.locator(".chat-pr").first(),
        ]),
      );
      expect(
        requests.map(
          (request) => (request.params as { refreshSessionKeys: string[] }).refreshSessionKeys,
        ),
      ).toEqual([[key], [key], [key]]);
      expect(afterReplay).toBe(2);
    } finally {
      await context.close();
    }
  });
});
