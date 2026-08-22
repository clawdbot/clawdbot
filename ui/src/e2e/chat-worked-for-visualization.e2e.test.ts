// Control UI E2E covers completed-work expansion and persistent visual outcomes.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

declare global {
  interface Window {
    pauseTranscriptResizeObservers: () => void;
    resumeTranscriptResizeObservers: () => void;
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI completed work visualizations",
  startServerBeforeBrowser: true,
});

async function captureProof(page: import("playwright").Page, name: string) {
  const artifactDir = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  if (!artifactDir) {
    return;
  }
  await fs.mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
}

suite.define(() => {
  it("keeps visual output visible and virtual rows apart when completed work expands", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1200 } }, async ({ page }) => {
      const sessionKey = "agent:main:dashboard:worked-for-geometry";
      await page.addInitScript(() => {
        const NativeResizeObserver = window.ResizeObserver;
        let paused = false;
        Object.defineProperties(window, {
          pauseTranscriptResizeObservers: {
            configurable: true,
            value: () => {
              paused = true;
            },
          },
          resumeTranscriptResizeObservers: {
            configurable: true,
            value: () => {
              paused = false;
            },
          },
        });
        window.ResizeObserver = class PausableResizeObserver extends NativeResizeObserver {
          constructor(callback: ResizeObserverCallback) {
            super((entries, observer) => {
              if (!paused) {
                callback(entries, observer);
              }
            });
          }
        };
      });
      await page.route("**/cv_worked_for_visual/index.html", async (route) => {
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html>
            <style>
              * { box-sizing: border-box; }
              html, body { margin: 0; min-height: 100%; background: #0d1017; color: #f4f6fa; font: 14px system-ui; }
              figure { margin: 0; padding: 20px 22px; }
              figcaption { margin-bottom: 16px; font-size: 13px; font-weight: 650; letter-spacing: .02em; }
              .row { display: grid; grid-template-columns: 72px 1fr 36px; align-items: center; gap: 10px; margin-top: 11px; }
              .label, .value { color: #b8c0cc; font-size: 12px; }
              .value { text-align: right; font-variant-numeric: tabular-nums; }
              .track { height: 10px; overflow: hidden; border-radius: 4px; background: #252b36; }
              .bar { height: 100%; border-radius: 4px; background: #76b7ff; }
            </style>
            <figure aria-label="Release confidence by platform">
              <figcaption>Release confidence</figcaption>
              <div class="row"><span class="label">Gateway</span><div class="track"><div class="bar" style="width:92%"></div></div><span class="value">92%</span></div>
              <div class="row"><span class="label">Control UI</span><div class="track"><div class="bar" style="width:84%"></div></div><span class="value">84%</span></div>
              <div class="row"><span class="label">Mobile</span><div class="track"><div class="bar" style="width:68%"></div></div><span class="value">68%</span></div>
            </figure>`,
        });
      });
      await installMockGateway(page, {
        sessionKey,
        historyMessages: [
          { role: "user", content: "Check it.", timestamp: 1_000 },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Here is the visualization." },
              {
                type: "canvas",
                preview: {
                  kind: "canvas",
                  surface: "assistant_message",
                  render: "url",
                  title: "Release status",
                  viewId: "cv_worked_for_visual",
                  url: "/__openclaw__/canvas/documents/cv_worked_for_visual/index.html",
                  preferredHeight: 180,
                  sandbox: "scripts",
                },
              },
            ],
            timestamp: 1_500,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Checking." }],
            openclawStreamFallback: {
              itemId: "worked-for-checking",
              replacementText: "Checking.",
              source: "segment",
            },
            timestamp: 2_000,
          },
          {
            role: "toolResult",
            toolCallId: "worked-for-tool",
            toolName: "bash",
            content: "ok",
            timestamp: 3_000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
            timestamp: 4_000,
          },
        ],
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByText("Done.", { exact: true }).waitFor();
      await page.locator('.chat-tool-card__preview[data-kind="canvas"]').waitFor();
      const workedFor = page.locator(".chat-work-group > .chat-activity-group__summary");
      await workedFor.waitFor();
      await waitForChatScrollIdle(page);
      await captureProof(page, "worked-for-geometry-collapsed");

      const geometry = await workedFor.evaluate(async (element) => {
        const owner = element.closest("openclaw-chat-pane") as
          | (HTMLElement & { updateComplete: Promise<unknown> })
          | null;
        const thread = element.closest<HTMLElement>(".chat-thread");
        if (!owner || !thread) {
          throw new Error("Worked-for disclosure is missing its chat pane or thread");
        }

        window.pauseTranscriptResizeObservers();
        (element as HTMLButtonElement).click();
        await owner.updateComplete;

        const viewport = thread.getBoundingClientRect();
        const rows = Array.from(thread.querySelectorAll<HTMLElement>(".chat-virtual-row"))
          .map((row) => {
            const rect = row.getBoundingClientRect();
            return { key: row.dataset.virtualRowKey, top: rect.top, bottom: rect.bottom };
          })
          .filter((row) => row.bottom > viewport.top && row.top < viewport.bottom);
        const overlaps = rows.flatMap((row, index) => {
          const next = rows[index + 1];
          return next && row.bottom > next.top ? [{ row, next }] : [];
        });

        return { expanded: element.getAttribute("aria-expanded"), rows, overlaps };
      });

      await captureProof(page, "worked-for-geometry-expanded");
      expect(geometry.expanded).toBe("true");
      expect(geometry.rows.length).toBeGreaterThanOrEqual(3);
      expect(geometry.overlaps).toEqual([]);

      await page.evaluate(() => window.resumeTranscriptResizeObservers());
      await workedFor.click();
      await workedFor.click();
      await waitForChatScrollIdle(page);
      await captureProof(page, "worked-for-geometry-settled");
    });
  });
});
