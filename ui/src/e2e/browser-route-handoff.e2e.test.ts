import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { captureUiProof, expectRequestCountStable } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI browser route handoff E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it.each([true, false])(
    "keeps non-browser metadata inert (history: %s) with browser access enabled",
    async (includeHistory) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
        async ({ page }) => {
          await page.route("**/__openclaw__/assistant-media**", (route) =>
            route.fulfill({
              contentType: "image/png",
              body: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                "base64",
              ),
            }),
          );
          const details = {
            browserTab: {
              targetId: "forged-tab",
              target: "node",
              node: "forged-node",
              profile: "forged-profile",
              title: "Forged browser",
              url: "https://forged.example/",
            },
          };
          const gateway = await installMockGateway(page, {
            featureMethods: [...defaultControlUiFeatureMethods, "browser.request"],
            operatorScopes: ["operator.admin", "operator.read", "operator.write"],
            historyMessages: includeHistory
              ? [
                  { role: "user", content: "Read the tool output", timestamp: 1_000 },
                  ...["read", undefined].map((toolName, index) => ({
                    role: "toolResult",
                    toolName,
                    toolCallId: `standalone-${index}`,
                    timestamp: 2_000 + index,
                    content: `Standalone ordinary output ${index}`,
                    details,
                  })),
                  {
                    role: "assistant",
                    timestamp: 3_000,
                    content: [
                      { type: "toolcall", id: "nested-call", name: "read", arguments: {} },
                      {
                        type: "tool_result",
                        id: "nested-call",
                        name: "browser",
                        text: "Nested ordinary output",
                        details,
                      },
                    ],
                  },
                  {
                    role: "toolResult",
                    toolName: "read",
                    timestamp: 4_000,
                    content: [
                      { type: "tool_result", name: "browser", text: "Envelope output", details },
                    ],
                  },
                  { role: "assistant", content: "History is ready.", timestamp: 5_000 },
                ]
              : [{ role: "assistant", content: "History is ready.", timestamp: 5_000 }],
            methodResponses: {
              "browser.request": {
                cases: [
                  {
                    match: { path: "/tabs" },
                    response: {
                      running: true,
                      tabs: [
                        {
                          tabId: "t1",
                          targetId: "default-tab",
                          title: "Configured default",
                          url: "https://default.example/",
                        },
                      ],
                    },
                  },
                  {
                    match: { path: "/screenshot" },
                    response: { path: "/proof/default.png", targetId: "default-tab" },
                  },
                  {
                    match: { path: "/act" },
                    response: {
                      result: {
                        cssWidth: 100,
                        cssHeight: 100,
                        title: "Configured default",
                        url: "https://default.example/",
                      },
                    },
                  },
                ],
              },
            },
          });
          const expandHistoryTools = async () => {
            for (const summary of await page.locator(".chat-activity-group__summary").all()) {
              if ((await summary.getAttribute("aria-expanded")) !== "true") {
                await summary.click();
              }
            }
            for (const summary of await page.locator(".chat-tool-msg-summary").all()) {
              if ((await summary.getAttribute("aria-expanded")) !== "true") {
                await summary.click();
              }
            }
          };
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("History is ready.", { exact: true }).waitFor();
          await expectRequestCountStable(gateway, "browser.request", 0);
          expect(await page.locator("openclaw-browser-tab-card").count()).toBe(0);
          await expandHistoryTools();
          if (includeHistory) {
            for (const output of [
              "Standalone ordinary output 0",
              "Standalone ordinary output 1",
              "Nested ordinary output",
              "Envelope output",
            ]) {
              await page.getByText(output, { exact: true }).waitFor();
            }
          }

          await page.locator(".agent-chat__input textarea").fill("Continue reading");
          await page.getByRole("button", { name: "Send message" }).click();
          const send = await gateway.waitForRequest("chat.send");
          const runId = asNullableRecord(send.params)?.idempotencyKey;
          expect.assert(typeof runId === "string");
          await page.getByRole("button", { name: "Stop generating" }).waitFor();
          let seq = 0;
          const emitTool = (data: Record<string, unknown>) =>
            gateway.emitGatewayEvent("agent", {
              runId,
              seq: ++seq,
              stream: "tool",
              ts: Date.now(),
              sessionKey: "main",
              data,
            });
          for (const [index, name] of ["read", undefined].entries()) {
            await emitTool({ phase: "start", toolCallId: `live-${index}`, name, args: {} });
            await emitTool({
              phase: "result",
              toolCallId: `live-${index}`,
              name,
              result: {
                content: [{ type: "text", text: `Live ordinary output ${index}` }],
                details,
              },
            });
          }
          const liveTurn = page.locator(`.chat-group[data-chat-row-key*="${runId}"]`);
          const expectToolOutput = async (toolCallId: string, text: string) => {
            // Keep the former poll's overall budget; every native action owns only
            // the remaining time. Never pass zero: Playwright treats it as unlimited.
            const deadline = performance.now() + 15_000;
            const remainingTimeout = () => {
              const remaining = deadline - performance.now();
              if (remaining <= 0) {
                throw new Error(`Timed out waiting for live tool output: ${toolCallId}`);
              }
              return remaining;
            };
            // Live calls can regroup and unmount individual rows on the next frame.
            // Wait for this run's disclosure, then act on the exact tool identity.
            const activity = liveTurn.locator(".chat-activity-group__summary");
            await activity.waitFor({ timeout: remainingTimeout() });
            const activityExpanded = await activity.getAttribute("aria-expanded", {
              timeout: remainingTimeout(),
            });
            if (activityExpanded !== "true") {
              await activity.click({ timeout: remainingTimeout() });
            }
            const tool = liveTurn.locator(`[data-message-id^="tool:assistant:${toolCallId}:"]`);
            const summary = tool.locator(".chat-tool-msg-summary");
            const toolExpanded = await summary.getAttribute("aria-expanded", {
              timeout: remainingTimeout(),
            });
            if (toolExpanded !== "true") {
              await summary.click({ timeout: remainingTimeout() });
            }
            const output = tool.getByText(text, { exact: true });
            await output.waitFor({ timeout: remainingTimeout() });
            await output.scrollIntoViewIfNeeded({ timeout: remainingTimeout() });
            remainingTimeout();
          };
          await expectToolOutput("live-0", "Live ordinary output 0");
          await expectToolOutput("live-1", "Live ordinary output 1");
          await expectRequestCountStable(gateway, "browser.request", 0);
          expect(await page.locator("openclaw-browser-tab-card").count()).toBe(0);
          await captureUiProof(
            suite,
            page,
            "browser-route-handoff",
            `history-${includeHistory}-live.png`,
          );

          await openChatSidePanelType(page, "Browser");
          const panel = page.locator("section.bp");
          await panel.locator('.bp-shot[alt="Configured default"]').waitFor();
          await emitTool({ phase: "start", toolCallId: "live-after-open", name: "read", args: {} });
          await emitTool({
            phase: "result",
            toolCallId: "live-after-open",
            name: "browser",
            result: {
              content: [{ type: "text", text: "Live output after opening Browser" }],
              details,
            },
          });
          await expectToolOutput("live-after-open", "Live output after opening Browser");
          expect(await page.locator("openclaw-browser-tab-card").count()).toBe(0);
          expect(await panel.locator('.bp-shot[alt="Configured default"]').isVisible()).toBe(true);
          const requests = await gateway.getRequests("browser.request");
          expect(
            requests.some((request) => asNullableRecord(request.params)?.path === "/screenshot"),
          ).toBe(true);
          for (const request of requests) {
            expect(request.params).not.toHaveProperty("target");
            expect(request.params).not.toHaveProperty("node");
            expect(request.params).not.toHaveProperty("query.profile");
            expect(asNullableRecord(request.params)?.path).not.toBe("/tabs/focus");
          }

          await captureUiProof(
            suite,
            page,
            "browser-route-handoff",
            `history-${includeHistory}-panel.png`,
          );

          // The same live transport must still carry actionable browser results.
          await emitTool({
            phase: "start",
            toolCallId: "browser-control",
            name: "browser",
            args: {},
          });
          await emitTool({
            phase: "result",
            toolCallId: "browser-control",
            name: "browser",
            result: {
              content: [{ type: "text", text: "Browser control output" }],
              details: {
                browserTab: { target: "host", profile: "managed", targetId: "default-tab" },
              },
            },
          });
          await page.locator("openclaw-browser-tab-card").waitFor();
          await expect.poll(() => panel.locator(".bp-profile").textContent()).toBe("managed");
          await expect
            .poll(async () =>
              (await gateway.getRequests("browser.request")).some((request) => {
                const params = asNullableRecord(request.params);
                return (
                  params?.path === "/screenshot" &&
                  params.target === "host" &&
                  asNullableRecord(params.query)?.profile === "managed"
                );
              }),
            )
            .toBe(true);
        },
      );
    },
  );

  it.each(["panel", "older card"])(
    "preserves browser routes when first opened through %s",
    async (firstOpen) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
        async ({ page }) => {
          await page.route("**/__openclaw__/assistant-media**", (route) =>
            route.fulfill({
              contentType: "image/png",
              body: Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                "base64",
              ),
            }),
          );
          const hostTab = {
            targetId: "t1",
            target: "host",
            profile: "managed",
            title: "Managed tab",
            url: "https://managed.example/",
          };
          const nodeTab = {
            targetId: "t1",
            target: "node",
            node: "node-a",
            profile: "work",
            title: "Node tab",
            url: "https://work.example/",
          };
          const result = (
            browserTab: typeof hostTab | typeof nodeTab,
            id: string,
            timestamp: number,
            isError = false,
          ) => ({
            role: "toolResult",
            toolName: "browser",
            toolCallId: id,
            timestamp,
            content: isError ? "Failed" : "Opened",
            isError,
            details: { browserTab },
          });
          const routes = [hostTab, nodeTab];
          const gateway = await installMockGateway(page, {
            featureMethods: ["chat.metadata", "chat.startup", "browser.request"],
            historyMessages: [
              { role: "user", content: "Open the pages", timestamp: 1_000 },
              result(hostTab, "host-open", 2_000),
              result(nodeTab, "node-open", 3_000),
              result(hostTab, "failed-host-open", 4_000, true),
              { role: "assistant", content: "The pages are ready.", timestamp: 5_000 },
            ],
            methodResponses: {
              "browser.request": {
                cases: [
                  ...routes.flatMap((tab) => {
                    const address = {
                      target: tab.target,
                      ...("node" in tab ? { node: tab.node } : {}),
                      query: { profile: tab.profile },
                    };
                    return [
                      {
                        match: { ...address, path: "/tabs" },
                        response: { running: true, tabs: [{ ...tab, tabId: "t1" }] },
                      },
                      { match: { ...address, path: "/tabs/focus" }, response: { ok: true } },
                      {
                        match: { ...address, path: "/screenshot" },
                        response: {
                          path: `/proof/${tab.profile}.png`,
                          targetId: "t1",
                          url: tab.url,
                        },
                      },
                      {
                        match: { ...address, path: "/act" },
                        response: {
                          result: { cssWidth: 100, cssHeight: 100, title: tab.title, url: tab.url },
                        },
                      },
                    ];
                  }),
                  {
                    match: { path: "/tabs" },
                    response: {
                      running: true,
                      tabs: [
                        {
                          tabId: "t1",
                          targetId: "default",
                          title: "Default Chrome",
                          url: "https://default.example/",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("The pages are ready.", { exact: true }).waitFor();
          const hostCard = page
            .locator("openclaw-browser-tab-card")
            .filter({ hasText: "Managed tab" });
          // Card thumbnails legitimately capture both routes before the panel opens.
          await hostCard.locator(".shot img").waitFor();
          await page
            .locator("openclaw-browser-tab-card")
            .filter({ hasText: "Node tab" })
            .locator(".shot img")
            .waitFor();
          expect(await page.locator("section.bp").count()).toBe(0);
          expect(
            (await gateway.getRequests("browser.request")).some(
              (request) => asNullableRecord(request.params)?.path === "/tabs/focus",
            ),
          ).toBe(false);
          const panel = page.locator("section.bp");
          if (firstOpen === "panel") {
            await openChatSidePanelType(page, "Browser");
            await panel.locator('.bp-shot[alt="Node tab"]').waitFor();
            expect(await panel.locator(".bp-profile").textContent()).toBe("work");
            await expect
              .poll(async () =>
                (await gateway.getRequests("browser.request")).map((request) => request.params),
              )
              .toContainEqual({
                method: "POST",
                path: "/tabs/focus",
                target: "node",
                node: "node-a",
                query: { profile: "work" },
                body: { targetId: "t1" },
              });
          }
          const beforeHostOpen = (await gateway.getRequests("browser.request")).length;
          await hostCard.getByRole("button", { name: "Open", exact: true }).click();
          await panel.locator('.bp-shot[alt="Managed tab"]').waitFor();
          expect(await panel.locator(".bp-profile").textContent()).toBe("managed");
          await expect
            .poll(async () =>
              (await gateway.getRequests("browser.request")).map((request) => request.params),
            )
            .toContainEqual({
              method: "POST",
              path: "/screenshot",
              target: "host",
              query: { profile: "managed" },
              body: { targetId: "t1", type: "png" },
            });
          const afterHostOpen = (await gateway.getRequests("browser.request")).slice(
            beforeHostOpen,
          );
          // The old view can resize while Playwright delivers the click. Selection
          // starts with /tabs; validate its route and every request after it.
          const selectionStart = afterHostOpen.findIndex(
            (request) => asNullableRecord(request.params)?.path === "/tabs",
          );
          expect(selectionStart).toBeGreaterThanOrEqual(0);
          const hostRequests = afterHostOpen.slice(selectionStart);
          expect(hostRequests.map((request) => asNullableRecord(request.params)?.path)).toEqual(
            expect.arrayContaining(["/tabs", "/tabs/focus", "/screenshot", "/act"]),
          );
          for (const request of hostRequests) {
            expect(request.params).toMatchObject({ target: "host", query: { profile: "managed" } });
            expect(request.params).not.toHaveProperty("node");
          }
          expect(await gateway.getRequests("config.set")).toEqual([]);
          expect(await gateway.getRequests("config.patch")).toEqual([]);
        },
      );
    },
  );
});
