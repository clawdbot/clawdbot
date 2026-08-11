import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI team secrets mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "secrets-store");

const envEntry: SecretStoreEntry = {
  name: "SERVICE_URL",
  kind: "env",
  value: "https://service.test",
  scopeKind: "team",
  scopeId: "",
  createdAtMs: 1_786_352_400_000,
  updatedAtMs: 1_786_352_400_000,
  updatedBy: "E2E Operator",
};

const secretEntry: SecretStoreEntry = {
  name: "SERVICE_API_KEY",
  kind: "secret",
  scopeKind: "team",
  scopeId: "",
  createdAtMs: 1_786_352_400_000,
  updatedAtMs: 1_786_352_400_000,
  updatedBy: "E2E Operator",
};

const bulkEnvEntry: SecretStoreEntry = {
  ...envEntry,
  name: "BULK_URL",
  value: "https://bulk.test",
};

const bulkSecretEntry: SecretStoreEntry = {
  ...secretEntry,
  name: "BULK_PRIVATE_KEY",
};

async function capture(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, fileName),
  });
}

async function tableBodyContrast(page: Page): Promise<number> {
  return await page
    .locator(".secrets-store__value")
    .first()
    .evaluate((element) => {
      const parse = (value: string) =>
        (value.match(/[\d.]+/gu) ?? []).slice(0, 3).map((channel) => Number(channel) / 255);
      const luminance = (channels: number[]) =>
        channels.reduce((sum, channel, index) => {
          const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
        }, 0);
      const group = element.closest(".settings-group");
      if (!group) {
        throw new Error("Missing settings group for contrast measurement");
      }
      const foreground = luminance(parse(getComputedStyle(element).color));
      const background = luminance(parse(getComputedStyle(group).backgroundColor));
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
}

suite.define(() => {
  it("adds env and secret values, bulk imports, and deletes without revealing secrets", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["secrets.store.list", "secrets.store.set", "secrets.store.delete"],
          methodResponses: {
            "secrets.store.list": {
              sequence: [
                { entries: [] },
                { entries: [envEntry] },
                { entries: [envEntry, secretEntry] },
                { entries: [envEntry, secretEntry, bulkSecretEntry] },
                { entries: [envEntry, secretEntry, bulkSecretEntry, bulkEnvEntry] },
                { entries: [envEntry, secretEntry, bulkSecretEntry] },
              ],
            },
            "secrets.store.set": {
              sequence: [
                { ok: true, reloaded: false },
                { ok: true, reloaded: true, warningCount: 0 },
                { ok: true, reloaded: false },
                { ok: true, reloaded: false },
              ],
            },
            "secrets.store.delete": { ok: true, reloaded: false },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/secrets`);
        await page.getByRole("heading", { name: "Secrets" }).waitFor();

        await page.getByRole("button", { name: "Add", exact: true }).click();
        const addDialog = page.locator('openclaw-modal-dialog[label="Add"]');
        await addDialog.getByLabel("Name", { exact: true }).fill("SERVICE_URL");
        await addDialog.getByLabel("Value", { exact: true }).fill("https://service.test");
        await capture(page, "02-add-dialog.png");
        await addDialog.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByRole("status").getByText("Saved SERVICE_URL.").waitFor();

        await page.getByRole("button", { name: "Add", exact: true }).click();
        const secretDialog = page.locator('openclaw-modal-dialog[label="Add"]');
        await secretDialog.getByLabel("Name", { exact: true }).fill("SERVICE_API_KEY");
        expect(await secretDialog.locator('input[type="checkbox"]').isChecked()).toBe(true);
        await secretDialog.getByLabel("Value", { exact: true }).fill("super-secret-material");
        await secretDialog.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByRole("status").getByText("Saved SERVICE_API_KEY.").waitFor();
        expect(await page.content()).not.toContain("super-secret-material");

        await page.getByRole("button", { name: "Bulk Add", exact: true }).click();
        const bulkDialog = page.locator('openclaw-modal-dialog[label="Bulk Add"]');
        await bulkDialog
          .getByRole("textbox", { name: "Value", exact: true })
          .fill('BULK_PRIVATE_KEY="line one\nline two"\nBULK_URL=https://bulk.test');
        await bulkDialog.getByText("1 secret detected").waitFor();
        await capture(page, "03-bulk-add-dialog.png");
        await bulkDialog.getByRole("button", { name: "Save", exact: true }).click();
        await page.getByRole("status").getByText("Saved 2 entries.").waitFor();

        const bulkRow = page.getByRole("row", { name: /BULK_URL/u });
        await bulkRow.getByRole("button", { name: "Actions: BULK_URL" }).click();
        await bulkRow.locator('wa-dropdown-item[value="delete"]').click();
        const confirm = page.locator('openclaw-modal-dialog[label="Delete"]');
        await confirm.getByRole("button", { name: "Delete", exact: true }).click();
        await page.getByRole("status").getByText("Deleted BULK_URL.").waitFor();
        expect(await page.getByRole("row", { name: /BULK_URL/u }).count()).toBe(0);

        expect(await gateway.getRequests("secrets.store.set")).toHaveLength(4);
        expect(await gateway.getRequests("secrets.store.delete")).toHaveLength(1);
        expect(await page.content()).not.toContain("super-secret-material");
        expect(await tableBodyContrast(page)).toBeGreaterThanOrEqual(9.5);
        await capture(page, "01-populated-dark.png");
      },
    );
  });

  it("keeps optional store actions hidden when the Gateway omits method discovery", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        omitFeatureMethods: true,
        methodResponses: {
          "secrets.store.list": { entries: [] },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/secrets`);
      await page.getByRole("heading", { name: "Secrets" }).waitFor();
      await page.getByText(/Gateway\/admin required/u).waitFor();
      expect(await page.getByRole("button", { name: "Add", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Bulk Add", exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("secrets.store.list")).toHaveLength(0);
    });
  });
});
