import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Attachment failure announcements" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureProof) {
    proofDir = createControlUiE2eArtifactDir("attachment-announcement");
  }
});

suite.define(() => {
  it.each(["ordinary", "completed"])(
    "announces a long %s reply's named failure without announcing initial history",
    async (flow) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const content = (label: string) => [
            { type: "text", text: "Here is the requested summary. ".repeat(25) },
            {
              type: "attachment_error",
              attachment: { code: "file-not-found", kind: "document", label },
            },
          ];
          const existing = {
            role: "assistant",
            content: content("previous.pdf"),
            timestamp: 1,
            __openclaw: { id: "existing-reply", seq: 1 },
          };
          const gateway = await installMockGateway(page, { historyMessages: [existing] });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page
            .locator(".chat-assistant-attachment-card", { hasText: "previous.pdf" })
            .waitFor();
          const announcement = page.locator(".chat-transcript-announcement");
          expect(await announcement.getAttribute("role")).toBe("status");
          expect(await announcement.getAttribute("aria-live")).toBe("polite");
          expect(await announcement.getAttribute("aria-atomic")).toBe("true");
          expect(await announcement.textContent()).toBe("");
          if (captureProof) {
            await page.screenshot({ path: path.join(proofDir, `${flow}-initial.png`) });
          }

          let runId: string | undefined;
          if (flow === "completed") {
            await page
              .locator(".agent-chat__composer-combobox textarea")
              .fill("Send the summary PDF");
            await page.getByRole("button", { name: "Send message" }).click();
            const request = await gateway.waitForRequest("chat.send");
            expect(request.params).toMatchObject({
              sessionKey: "agent:main:main",
              message: "Send the summary PDF",
              deliver: false,
              idempotencyKey: expect.any(String),
            });
            runId = (request.params as { idempotencyKey: string }).idempotencyKey;
          }
          const reply = {
            role: "assistant",
            content: content("missing.pdf"),
            timestamp: Date.now(),
            ...(runId ? { runId, phase: "final_answer" } : {}),
            __openclaw: { id: "appended-reply", seq: 3 },
          };
          await gateway.setHistoryMessages([existing, reply]);
          if (runId) {
            await gateway.emitGatewayEvent("chat", {
              message: reply,
              runId,
              sessionKey: "agent:main:main",
              state: "final",
            });
          } else {
            await gateway.emitGatewayEvent("session.message", {
              message: reply,
              messageId: "appended-reply",
              messageSeq: 3,
              sessionKey: "agent:main:main",
              activeRunIds: [],
              hasActiveRun: false,
            });
          }
          const card = page.locator(".chat-assistant-attachment-card", { hasText: "missing.pdf" });
          await card.waitFor();
          await card.scrollIntoViewIfNeeded();
          const cardText = await card.textContent();
          expect(cardText).toContain("Not sent");
          expect(cardText).toContain("File not found. Check the path and try again.");
          await expect.poll(() => announcement.textContent()).not.toBe("");
          const text = (await announcement.textContent()) ?? "";
          if (captureProof) {
            const stage = text.includes("missing.pdf") ? "after" : "before";
            await page.screenshot({ path: path.join(proofDir, `${flow}-${stage}.png`) });
            await writeFile(
              path.join(proofDir, `${flow}-${stage}.json`),
              JSON.stringify({ flow, text, length: text.length, card: cardText }, null, 2),
            );
          }
          expect(text).toContain(
            "missing.pdf: Not sent. File not found. Check the path and try again.",
          );
          expect(text).toContain("Here is the requested summary.");
          expect(text.length).toBe(500);
        },
      );
    },
  );
});
