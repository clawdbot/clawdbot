import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI channel wizard option contrast",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for channel wizard contrast proof at ${executablePath}`,
});

const proofVariant = process.env.OPENCLAW_PICKER_PROOF_VARIANT;
let proofDirectory: string;
beforeEach(() => {
  if (proofVariant) {
    proofDirectory = createControlUiE2eArtifactDir("channel-wizard-option-contrast");
  }
});

suite.define(() => {
  it("keeps option subtext legible and keyboard focus visible in forced colors", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["channels.status", "channels.pairing.list", "wizard.start"],
          methodResponses: {
            "channels.status": {
              ts: Date.now(),
              channelOrder: ["imessage"],
              channelLabels: { imessage: "iMessage" },
              channelMeta: [{ id: "imessage", label: "iMessage" }],
              channels: { imessage: { configured: true, running: true } },
              channelAccounts: {},
              channelDefaultAccountId: {},
            },
            "channels.pairing.list": {
              accounts: [],
              requests: [],
              commandOwnerConfigured: true,
              limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
            },
            "wizard.start": {
              sessionId: "channel-option-contrast-proof",
              done: false,
              status: "running",
              step: {
                id: "account",
                type: "select",
                message: "Account",
                initialValue: "primary",
                options: [
                  {
                    value: "primary",
                    label: "Primary iMessage connection",
                    hint: "The main iMessage connection for this OpenClaw gateway",
                  },
                  {
                    value: "another",
                    label: "Add another iMessage account",
                  },
                ],
              },
            },
          },
        });

        expect((await page.goto(`${suite.server.baseUrl}settings/channels`))?.status()).toBe(200);
        await page.locator(".channels-item", { hasText: "iMessage" }).first().click();
        await page.locator(".channels-detail").getByRole("button", { name: "Run setup" }).click();

        const wizard = page.locator(".channels-wizard");
        const picker = wizard.locator("wa-select");
        await picker.click();
        await expect.poll(() => picker.getAttribute("open")).not.toBeNull();

        const activeOption = wizard.locator("wa-option").filter({
          has: page.getByText("Primary iMessage connection", { exact: true }),
        });
        await expect
          .poll(() => activeOption.evaluate((option) => option.matches(":state(current)")))
          .toBe(true);
        const colors = await activeOption.evaluate((option) => {
          const label = option.querySelector<HTMLElement>(".picker-select__label");
          const description = option.querySelector<HTMLElement>(".picker-select__description");
          if (!label || !description) {
            throw new Error("Expected the active picker option label and description");
          }
          return {
            background: getComputedStyle(option).backgroundColor,
            description: getComputedStyle(description).color,
            label: getComputedStyle(label).color,
          };
        });

        if (proofVariant) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDirectory, `${proofVariant}.png`),
          });
          await writeFile(
            path.join(proofDirectory, `${proofVariant}.json`),
            `${JSON.stringify(colors, null, 2)}\n`,
          );
        }

        expect(colors.description).toBe(colors.label);

        await page.emulateMedia({ forcedColors: "active" });
        await page.keyboard.press("ArrowDown");
        const nextOption = picker.getByRole("option", { name: "Add another iMessage account" });
        await expect
          .poll(() => nextOption.evaluate((option) => option.matches(":focus-visible")))
          .toBe(true);
        expect(
          await nextOption.evaluate((option) => {
            const style = getComputedStyle(option);
            return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
          }),
        ).toBe(true);
        expect(await activeOption.getAttribute("aria-selected")).toBe("true");
        await page.keyboard.press("Enter");
        const answer = await gateway.waitForRequest("wizard.next");
        expect(answer.params).toMatchObject({ answer: { value: "another" } });
      },
    );
  });
});
