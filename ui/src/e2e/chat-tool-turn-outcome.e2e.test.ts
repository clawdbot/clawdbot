// Control UI E2E tests cover autonomous tool-turn outcome rendering.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI autonomous tool-turn outcomes",
  startServerBeforeBrowser: true,
});

function failedTool(timestamp: number) {
  return {
    role: "toolResult",
    toolName: "shell",
    content: JSON.stringify({ status: "failed", exitCode: 1 }),
    isError: true,
    timestamp,
  };
}

async function captureToolActivityProof(page: import("playwright").Page, name: string) {
  const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  if (!artifactDir) {
    return;
  }
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
}

async function captureFactrowProof(
  page: import("playwright").Page,
  activity: import("playwright").Locator,
  theme: "dark" | "light",
) {
  const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  if (!artifactDir) {
    return;
  }
  const state = process.env.OPENCLAW_FACTROW_PROOF_STATE?.trim() || "after";
  await fs.mkdir(artifactDir, { recursive: true });
  await page.locator(".chat-main").screenshot({
    path: path.join(artifactDir, `factrow-${state}-${theme}-context.png`),
  });
  await activity.screenshot({
    path: path.join(artifactDir, `factrow-${state}-${theme}-rows.png`),
  });
}

suite.define(() => {
  it("keeps an earlier autonomous failure visible after a later turn recovers", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const sessionKey = "agent:main:dashboard:tool-turn-outcome";
    await installMockGateway(page, {
      sessionKey,
      historyMessages: [
        failedTool(1),
        {
          role: "assistant",
          content: [{ type: "text", text: "Start the next autonomous task." }],
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          senderLabel: "Forwarded from main",
          timestamp: 2,
        },
        failedTool(3),
        {
          role: "assistant",
          content: [{ type: "text", text: "Recovered on the next autonomous turn." }],
          timestamp: 4,
        },
      ],
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await page.getByText("Recovered on the next autonomous turn.", { exact: true }).waitFor();

    expect(await page.locator(".chat-tool-msg-summary__label").allTextContents()).toEqual([
      "Tool output",
      "Tool output",
    ]);
    // Collapsed rows stay neutral even when the call failed; the failure is
    // recorded as the expanded body's outcome, with the reported exit code.
    const summaryClasses = await page
      .locator(".chat-tool-msg-summary")
      .evaluateAll((nodes) => nodes.map((node) => node.className));
    expect(summaryClasses).toHaveLength(2);
    expect(summaryClasses[0]).not.toContain("chat-tool-msg-summary--error");
    expect(summaryClasses[1]).not.toContain("chat-tool-msg-summary--error");
    await page.locator(".chat-tool-msg-summary").first().click();
    await expect
      .poll(() => page.locator(".chat-tool-card__outcome").first().textContent())
      .toBe("Exit code 1");
    await context.close();
  });

  it("pairs a canonical parallel batch and renders per-file patch sections", async () => {
    const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      locale: "en-US",
      viewport: { height: 900, width: 1200 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1200 } } }
        : {}),
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-read",
              name: "read",
              arguments: { path: "/repo/src/a.ts", offset: 3, limit: 20 },
            },
            {
              type: "toolCall",
              id: "call-patch",
              name: "apply_patch",
              arguments: {
                input: [
                  "*** Begin Patch",
                  "*** Update File: src/a.ts",
                  "@@",
                  "-const before = true;",
                  "+const after = true;",
                  "*** Add File: src/b.ts",
                  "+export const created = true;",
                  "*** End Patch",
                ].join("\n"),
              },
            },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          content: [{ type: "text", text: "A_ONLY_fixture" }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-patch",
          toolName: "apply_patch",
          content: [{ type: "text", text: "Applied patch" }],
          timestamp: 3,
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const activity = page.locator(".chat-group--activity .chat-activity-group__summary");
    await activity.waitFor();
    expect(await activity.textContent()).toContain("Read a file, edited a file, created a file");
    const activityGeometry = await activity.evaluate((node) => {
      const container = node.closest<HTMLElement>(".chat-activity-group");
      const label = node.querySelector<HTMLElement>(".chat-activity-group__label");
      const chevron = node.querySelector<HTMLElement>(".chat-tool-row__chevron");
      if (!container || !label || !chevron) {
        throw new Error("Expected compact activity disclosure parts");
      }
      const containerRect = container.getBoundingClientRect();
      const summaryRect = node.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const chevronRect = chevron.getBoundingClientRect();
      return {
        containerWidth: containerRect.width,
        summaryWidth: summaryRect.width,
        chevronGap: chevronRect.left - labelRect.right,
      };
    });
    expect(activityGeometry.summaryWidth).toBeLessThan(activityGeometry.containerWidth);
    expect(activityGeometry.chevronGap).toBeLessThanOrEqual(8);
    await activity.hover();
    expect(await activity.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      "rgba(0, 0, 0, 0)",
    );
    if ((await activity.getAttribute("aria-expanded")) !== "true") {
      await activity.click();
    }

    const rows = page.locator(".chat-activity-group__body .chat-tool-msg-summary");
    expect(await rows.count()).toBe(2);
    expect(await rows.locator(".chat-tool-row__chevron").count()).toBe(2);
    expect(await page.locator(".chat-tool-msg-summary__label", { hasText: "Tool" }).count()).toBe(
      0,
    );
    // File rows put the workspace link inside the row, so toggle from the icon
    // edge instead of the row centre to avoid opening the linked file.
    await rows.first().click({ position: { x: 4, y: 4 } });
    expect(await page.getByText("offset:", { exact: true }).count()).toBe(1);
    expect(await page.getByText("limit:", { exact: true }).count()).toBe(1);
    const patchRow = rows.filter({ hasText: "2 files" });
    await patchRow.click();

    expect(await page.locator(".chat-diff__row--file .chat-diff__text").allTextContents()).toEqual([
      "Update src/a.ts",
      "Add src/b.ts",
    ]);
    expect(await page.locator(".chat-diff__row--del .chat-diff__text").allTextContents()).toContain(
      "const before = true;",
    );
    expect(await page.locator(".chat-diff__row--add .chat-diff__text").allTextContents()).toEqual(
      expect.arrayContaining(["const after = true;", "export const created = true;"]),
    );
    const rawDetails = page.getByRole("button", { name: "Raw details" });
    await rawDetails.click();
    await page.getByText("Applied patch", { exact: true }).waitFor();
    await captureToolActivityProof(page, "parallel-multifile-expanded");
    await context.close();
  });

  it("preserves mixed producer-recorded file operations in a realistic agent turn", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "light",
      locale: "en-US",
      viewport: { height: 760, width: 1120 },
    });
    const page = await context.newPage();
    const timestamp = Date.UTC(2026, 7, 11, 18, 30);
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "user",
          content:
            "Please update the release helper: add the summary module, fix the stable-channel plan, remove the legacy formatter, and run the focused test.",
          timestamp,
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "I’ll make those three scoped file changes, then run the focused release-plan test.",
            },
          ],
          timestamp: timestamp + 1_000,
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-release-patch",
              name: "apply_patch",
              arguments: {
                changes: [
                  {
                    path: "src/release/release-summary.ts",
                    kind: { type: "add" },
                    diff: "export function formatReleaseSummary(version: string) {\n  return `Release ${version} is ready.`;\n}\n",
                  },
                  {
                    path: "src/release/release-plan.ts",
                    kind: { type: "update" },
                    diff: [
                      "@@ -8,3 +8,3 @@",
                      "-export const releaseChannel = 'beta';",
                      "+export const releaseChannel = 'stable';",
                    ].join("\n"),
                  },
                  {
                    path: "src/release/legacy-format.ts",
                    kind: { type: "delete" },
                    diff: "export const legacyReleaseFormat = true;\n",
                  },
                ],
              },
            },
            {
              type: "toolCall",
              id: "call-release-test",
              name: "exec",
              arguments: { command: "pnpm test src/release/release-plan.test.ts" },
            },
          ],
          timestamp: timestamp + 2_000,
        },
        {
          role: "toolResult",
          toolCallId: "call-release-patch",
          toolName: "apply_patch",
          content: [{ type: "text", text: "Applied patch" }],
          timestamp: timestamp + 3_000,
        },
        {
          role: "toolResult",
          toolCallId: "call-release-test",
          toolName: "exec",
          content: [{ type: "text", text: "PASS src/release/release-plan.test.ts (8 tests)" }],
          timestamp: timestamp + 4_000,
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Done. The summary module is in place, the stable-channel plan is updated, the legacy formatter is removed, and all 8 focused tests pass.",
            },
          ],
          timestamp: timestamp + 5_000,
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Done. The summary module is in place", { exact: false }).waitFor();
    const activity = page.locator(".chat-group--activity");
    const summary = activity.locator(".chat-activity-group__summary");
    if ((await summary.getAttribute("aria-expanded")) !== "true") {
      await summary.click();
    }

    const patchRow = activity.locator(".chat-tool-msg-summary", { hasText: "3 files" });
    const commandRow = activity.locator(".chat-tool-msg-summary", {
      hasText: "pnpm test src/release/release-plan.test.ts",
    });
    await patchRow.waitFor();
    await commandRow.waitFor();
    await captureFactrowProof(page, activity, "light");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.themeMode))
      .toBe("dark");
    await captureFactrowProof(page, activity, "dark");
    expect(await summary.textContent()).toContain(
      "Ran a command, edited a file, created a file, deleted a file",
    );
    expect(await patchRow.locator(".chat-tool-row__verb").textContent()).toBe("Changed");
    await context.close();
  });

  it("shows native tool input when the result sorts before its call", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-native",
              name: "example_tool",
              arguments: { query: "example" },
            },
          ],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-native",
          toolName: "example_tool",
          content: [{ type: "text", text: "Native result payload" }],
          timestamp: 1,
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const row = page.locator(".chat-tool-msg-summary");
    await row.waitFor();
    expect(await row.count()).toBe(1);
    await row.click();
    const card = page.locator(".chat-tool-card");
    await card.waitFor();
    expect(await card.getByText("query:", { exact: true }).count()).toBe(1);
    expect(await card.getByText("example", { exact: true }).count()).toBe(1);
    // Plain output needs no "Tool output" header; the payload is the content.
    expect(await card.getByText("Tool output", { exact: true }).count()).toBe(0);
    await card.getByText("Native result payload", { exact: true }).waitFor();
    await captureToolActivityProof(page, "native-result-before-call-expanded");
    await context.close();
  });

  it("keeps a message-only turn visible with its first message line", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const message = "Hello Molty, first claw-to-claw hello.";
    await installMockGateway(page, {
      historyMessages: [
        { role: "user", content: "Send the Reef greeting.", timestamp: 1 },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-message",
              name: "message",
              arguments: {
                action: "send",
                channel: "reef",
                target: "@molty",
                message: `${message}\nHidden second line.`,
              },
            },
          ],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call-message",
          toolName: "message",
          content: [{ type: "text", text: '{"status":"sent"}' }],
          timestamp: 3,
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const row = page.locator(".chat-tool-msg-summary", { hasText: message });
    await row.waitFor();

    expect(await row.locator(".chat-tool-msg-summary__label").textContent()).toBe("Message");
    expect(await row.locator(".chat-tool-msg-summary__names").textContent()).toBe(message);
    await captureToolActivityProof(page, "message-only-turn-visible");
    await row.click();
    await page.getByText("action:", { exact: true }).waitFor();
    expect(await page.getByText("send", { exact: true }).count()).toBe(1);
    expect(await page.getByText("Hidden second line.", { exact: false }).count()).toBeGreaterThan(
      0,
    );
    await context.close();
  });

  it("sweeps a text wave over the active tool row and stops it on the result", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Ready for the running tool wave proof." }],
          timestamp: Date.now(),
        },
      ],
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText("Ready for the running tool wave proof.").waitFor();
    await page.locator(".agent-chat__input textarea").fill("run a long command");
    await page.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    const runId = (send.params as { idempotencyKey?: string }).idempotencyKey as string;

    await gateway.emitGatewayEvent("agent", {
      runId,
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        toolCallId: "call-wave",
        name: "exec",
        phase: "start",
        args: { command: "pnpm check:changed" },
      },
    });
    // Start-phase sync is throttled and repaints on the next event, so follow
    // with a delta (as real runs do) to surface the live card.
    await page.waitForTimeout(200);
    await gateway.emitGatewayEvent("chat", {
      deltaText: "Working on it.",
      message: {
        content: [{ text: "Working on it.", type: "text" }],
        role: "assistant",
        timestamp: Date.now(),
      },
      runId,
      sessionKey: "main",
      state: "delta",
    });
    await page.getByText("Working on it.").waitFor();

    const runningRow = page.locator(".chat-tool-row--running");
    await runningRow.waitFor();
    // Visual-regression guard for the active-task text wave: the running
    // command text must carry the glyph-clipped gradient animation.
    const wave = await runningRow.locator(".chat-tool-row__cmd").evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        animationName: style.animationName,
        backgroundClip: style.getPropertyValue("-webkit-background-clip") || style.backgroundClip,
        color: style.color,
      };
    });
    expect(wave.animationName).toBe("chatToolRowTextWave");
    expect(wave.backgroundClip).toBe("text");
    expect(wave.color).toBe("rgba(0, 0, 0, 0)");
    await captureToolActivityProof(page, "tool-row-running-text-wave");

    await gateway.emitGatewayEvent("agent", {
      runId,
      seq: 2,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        toolCallId: "call-wave",
        name: "exec",
        phase: "result",
        result: { text: "done" },
      },
    });
    // The wave is a live-run marker only: the result event must end it and
    // restore plain text color even though the run has not finished yet.
    await expect.poll(() => page.locator(".chat-tool-row--running").count()).toBe(0);
    const settled = await page
      .locator(".chat-tool-row__cmd")
      .first()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return { animationName: style.animationName, color: style.color };
      });
    expect(settled.animationName).toBe("none");
    expect(settled.color).not.toBe("rgba(0, 0, 0, 0)");
    await context.close();
  });
});
