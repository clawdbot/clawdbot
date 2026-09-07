// Control UI E2E covers pooling reply-less wake activity (heartbeats) into one rollup row.
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";

let artifactDir: string | undefined;
beforeEach(() => {
  const parent = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  artifactDir = parent
    ? createControlUiE2eArtifactDir("chat-heartbeat-activity-rollup", parent)
    : undefined;
});
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI heartbeat activity rollup",
  startServerBeforeBrowser: true,
});

async function captureProof(page: import("playwright").Page, name: string) {
  if (!artifactDir) {
    return;
  }
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
}

function heartbeatWake(index: number): Array<Record<string, unknown>> {
  const runId = `heartbeat-run-${index}`;
  const callId = `heartbeat-call-${index}`;
  const timestamp = 10_000 + index * 1_000;
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: callId,
          name: "heartbeat_respond",
          arguments: { notify: false },
        },
      ],
      runId,
      timestamp,
    },
    {
      role: "toolResult",
      toolCallId: callId,
      toolName: "heartbeat_respond",
      content: "ok",
      runId,
      timestamp: timestamp + 100,
    },
  ];
}

suite.define(() => {
  it("pools consecutive reply-less heartbeat wakes into one expandable rollup", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1200 } }, async ({ page }) => {
      const sessionKey = "agent:main:dashboard:heartbeat-rollup";
      const wakeCount = 6;
      await installMockGateway(page, {
        sessionKey,
        historyMessages: [
          { role: "user", content: "Watch the queue.", timestamp: 1_000, runId: "reply-run" },
          {
            role: "assistant",
            content: [{ type: "text", text: "Watching." }],
            timestamp: 2_000,
            runId: "reply-run",
          },
          ...Array.from({ length: wakeCount }, (_, index) => heartbeatWake(index + 1)).flat(),
        ],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByText("Watching.", { exact: true }).waitFor();
      await waitForChatScrollIdle(page);

      const rollup = page.locator(".chat-group--activity .chat-activity-group__summary");
      await rollup.waitFor();
      await expect
        .poll(async () => rollup.locator(".chat-activity-group__label").textContent())
        .toBe(`Used Heartbeat Respond ×${wakeCount}`);
      // One pooled row owns all wakes; no per-wake rows remain in the transcript.
      expect(await rollup.count()).toBe(1);
      expect(await page.locator(".chat-tool-row").count()).toBe(0);
      await captureProof(page, "heartbeat-rollup-collapsed");

      await rollup.click();
      await expect
        .poll(async () => page.locator(".chat-activity-group__body .chat-tool-row").count())
        .toBe(wakeCount);
      await waitForChatScrollIdle(page);
      await captureProof(page, "heartbeat-rollup-expanded");
    });
  });
});
