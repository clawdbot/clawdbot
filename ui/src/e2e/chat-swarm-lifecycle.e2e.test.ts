import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Swarm lifecycle",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:dashboard:11111111-2222-4333-8444-555555555555";
const groupId = `swarm:${sessionKey}:11111111-2222-4333-8444-666666666666`;

suite.define(() => {
  it.each([
    { name: "desktop", width: 1440, height: 900, count: 1 },
    { name: "mobile", width: 390, height: 844, count: 1 },
    { name: "mobile-many", width: 390, height: 844, count: 30 },
  ])("collapses successful child runs without hiding their details on $name", async (viewport) => {
    const proofDir = createControlUiE2eArtifactDir(`completed-swarm-${viewport.name}`);
    await suite.withPage(
      { viewport, hasTouch: viewport.name.startsWith("mobile") },
      async ({ page }) => {
        const children = Array.from({ length: viewport.count }, (_, index) => ({
          key: `agent:main:subagent:completed-${index}`,
          kind: "direct",
          label: "Research worker visibility after reconnect",
          parentSessionKey: sessionKey,
          swarmGroupId: groupId,
          status: "running",
          updatedAt: 1,
        }));
        const group = {
          groupId,
          createdAt: 1,
          queued: 0,
          running: viewport.count,
          done: 0,
          failed: 0,
          children: children.map((child) => ({ sessionKey: child.key, status: "running" })),
        };
        const parent = {
          key: sessionKey,
          kind: "direct",
          label: "Research comparison",
          updatedAt: 1,
          swarm: { groups: [group], otherActiveGroups: 0 },
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [parent, ...children],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Research results are in the conversation." }],
            },
          ],
          methodResponses: {
            "sessions.list": chatSessionListResponse([parent, ...children]),
            "sessions.describe": { session: parent },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const widget = page.locator('[data-test-id="chat-swarm"]');
        const disclosure = widget.locator("details");
        const summary = disclosure.locator("summary");
        await expect.poll(() => widget.locator(".chat-swarm__task").count()).toBe(viewport.count);
        expect(await widget.locator(".chat-swarm__markers").isVisible()).toBe(true);
        await page.screenshot({ path: path.join(proofDir, "active.png"), animations: "disabled" });

        // The collector summary owns completion even while child rows are stale.
        const completedParent = {
          ...parent,
          updatedAt: 2,
          swarm: {
            groups: [
              {
                ...group,
                running: 0,
                done: viewport.count,
                children: children.map((child) => ({ sessionKey: child.key, status: "done" })),
              },
            ],
            otherActiveGroups: 0,
          },
        };
        await gateway.setMethodResponse("sessions.describe", { session: completedParent });
        await gateway.setMethodResponse(
          "sessions.list",
          chatSessionListResponse([completedParent, ...children]),
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          agentId: "main",
          reason: "swarm",
        });
        await expect
          .poll(() => widget.locator(".chat-swarm__tasks .chat-swarm__task-icon--done").count())
          .toBe(viewport.count);
        await page.screenshot({
          path: path.join(proofDir, "completed.png"),
          animations: "disabled",
        });
        const box = await disclosure.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeLessThanOrEqual(64);
        expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect(await summary.textContent()).toContain(`${viewport.count} completed`);
        expect(await disclosure.getAttribute("open")).toBeNull();
        expect(await widget.locator(".chat-swarm__tasks").isVisible()).toBe(false);
        expect(await page.locator(".agent-chat__composer-combobox textarea").isVisible()).toBe(
          true,
        );
        await summary.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => widget.locator(".chat-swarm__tasks").isVisible()).toBe(true);
        expect(
          await widget
            .getByText("Child runs finished. Check the conversation for the final response.")
            .isVisible(),
        ).toBe(true);
        await page.screenshot({
          path: path.join(proofDir, "completed-details.png"),
          animations: "disabled",
        });
        await page.keyboard.press("Space");
        await expect.poll(() => widget.locator(".chat-swarm__tasks").isVisible()).toBe(false);
        await page.reload();
        await expect
          .poll(() => widget.locator(".chat-swarm__tasks .chat-swarm__task-icon--done").count())
          .toBe(viewport.count);
        expect((await disclosure.boundingBox())!.height).toBeLessThanOrEqual(64);
        expect(await disclosure.getAttribute("open")).toBeNull();
        await summary.click();
        await expect.poll(() => widget.locator(".chat-swarm__tasks").isVisible()).toBe(true);
      },
    );
  });
  it.each([
    { name: "desktop", width: 1440, height: 900, childAgent: "main" },
    { name: "mobile", width: 390, height: 844, childAgent: "main" },
    { name: "cross-agent", width: 1440, height: 900, childAgent: "worker" },
  ])("keeps a thirty-child outcome visible after the parent fails on $name", async (viewport) => {
    const proofDir = createControlUiE2eArtifactDir(`swarm-lifecycle-${viewport.name}`);
    await suite.withPage({ viewport, hasTouch: viewport.name === "mobile" }, async ({ page }) => {
      const now = Date.now();
      const parent = {
        key: sessionKey,
        kind: "direct",
        label: "Research comparison",
        status: "running",
        hasActiveRun: true,
        updatedAt: now,
        swarm: {
          groups: [
            {
              groupId,
              createdAt: now,
              children: Array.from({ length: 30 }, (_, index) => ({
                sessionKey: `agent:${viewport.childAgent}:subagent:research-${index}`,
                status: index < 8 ? "running" : "queued",
              })),
              queued: 22,
              running: 8,
              done: 0,
              failed: 0,
            },
          ],
          otherActiveGroups: 0,
        },
      };
      const children = Array.from({ length: 30 }, (_, index) => ({
        key: `agent:${viewport.childAgent}:subagent:research-${index}`,
        kind: "direct",
        label: `Research lane ${index + 1}`,
        parentSessionKey: sessionKey,
        spawnedBy: sessionKey,
        swarmGroupId: groupId,
        status: index < 8 ? "running" : "queued",
        hasActiveRun: true,
        updatedAt: now,
        ...(index < 8 ? { startedAt: now - 1_000 } : {}),
      }));
      // Keep children outside the sidebar page so only real child hydration can
      // populate the chart. A whole-session fixture would hide a broken fetch.
      const listResponse = (rows: typeof children, parentRow = parent) => ({
        cases: [
          { match: { spawnedBy: sessionKey }, response: chatSessionListResponse(rows) },
          { match: {}, response: chatSessionListResponse([parentRow]) },
        ],
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [parent, ...children],
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Research is running." }] },
        ],
        methodResponses: {
          "sessions.list": listResponse(children),
          "sessions.describe": { session: parent },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("sessions.list", { match: { spawnedBy: sessionKey } });
      const widget = page.locator('[data-test-id="chat-swarm"]');
      await widget.waitFor();
      await expect.poll(() => widget.locator(".chat-swarm__task").count()).toBe(30);
      await expect
        .poll(() => widget.locator(".chat-swarm__header").textContent())
        .toContain("0 of 30");
      expect(
        await widget.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight;
        }),
      ).toBe(true);
      await page.screenshot({ path: path.join(proofDir, "active.png"), animations: "disabled" });
      const group = widget.locator("[data-swarm-group]");
      if (viewport.name === "mobile") {
        await group.locator("summary").tap();
      } else {
        await group.locator("summary").click();
      }
      await expect.poll(() => widget.locator(".chat-swarm__tasks").isVisible()).toBe(true);
      await page.screenshot({
        path: path.join(proofDir, "active-details.png"),
        animations: "disabled",
      });

      const endedAt = now + 60_000;
      const completed = children.map((row, index) =>
        Object.assign(row, {
          status: index < 25 ? "done" : "failed",
          hasActiveRun: false,
          updatedAt: endedAt,
          startedAt: now,
          endedAt,
        }),
      );
      const failedParent = {
        ...parent,
        status: "failed",
        hasActiveRun: false,
        updatedAt: endedAt,
        swarm: {
          groups: [
            {
              groupId,
              createdAt: now,
              children: Array.from({ length: 30 }, (_, index) => ({
                sessionKey: `agent:${viewport.childAgent}:subagent:research-${index}`,
                status: index < 25 ? "done" : "failed",
              })),
              queued: 0,
              running: 0,
              done: 25,
              failed: 5,
            },
          ],
          otherActiveGroups: 0,
        },
      };
      await gateway.setSessionsListResponse(
        chatSessionListResponse([failedParent, ...completed.slice(18)]),
      );
      await gateway.setMethodResponse(
        "sessions.list",
        listResponse(completed.slice(18), failedParent),
      );
      await gateway.setMethodResponse("sessions.describe", { session: failedParent });
      const reads = (await gateway.getRequests("sessions.list", { spawnedBy: sessionKey })).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        agentId: "main",
        reason: "swarm",
      });
      await gateway.waitForRequest("sessions.list", {
        after: reads,
        match: { spawnedBy: sessionKey },
      });
      await expect.poll(() => widget.count()).toBe(1);
      await expect
        .poll(() => widget.locator(".chat-swarm__header").textContent())
        .toContain("30 of 30");
      expect(await widget.locator(".chat-swarm__marker--failed").count()).toBe(5);
      expect(await widget.locator(".chat-swarm__marker--done").count()).toBe(25);
      await page.screenshot({ path: path.join(proofDir, "terminal.png"), animations: "disabled" });
      await page.reload();
      await widget.waitFor();
      await expect.poll(() => widget.count()).toBe(1);
      await expect
        .poll(() => widget.locator(".chat-swarm__header").textContent())
        .toContain("30 of 30");
      await page.screenshot({
        path: path.join(proofDir, "terminal-reloaded.png"),
        animations: "disabled",
      });
    });
  });
});
