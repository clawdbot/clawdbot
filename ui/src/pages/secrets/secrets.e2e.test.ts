import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI team secrets mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    proofDir = createControlUiE2eArtifactDir(
      "secrets-store",
      path.join(process.cwd(), ".artifacts", "control-ui-e2e", "secrets-store"),
    );
  }
});

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
  allowedHosts: ["api.example.com"],
};

const bulkEnvEntry: SecretStoreEntry = {
  ...envEntry,
  name: "BULK_URL",
  value: "https://bulk.test",
};

const bulkSecretEntry: SecretStoreEntry = {
  ...secretEntry,
  name: "BULK_PRIVATE_KEY",
  allowedHosts: [],
};

async function capture(
  page: Page,
  fileName: string,
  surface: Locator = page.locator(".shell"),
  content: readonly Locator[] = [
    page.locator(".settings-section__heading", { hasText: "Secrets" }),
  ],
) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  if (page.video()) {
    await writeFile(
      path.join(proofDir, fileName),
      await takeControlUiViewportScreenshot(page, surface, content),
    );
  } else {
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: path.join(proofDir, fileName),
    });
  }
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

async function activeGatewayIdentity(page: Page) {
  return await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: {
        context: {
          gateway: {
            connection: { gatewayUrl: string };
            snapshot: { client: { instanceId: string } | null; phase: string };
          };
        };
      };
    };
    const gateway = app.runtime?.context.gateway;
    return {
      clientInstanceId: gateway?.snapshot.client?.instanceId,
      gatewayUrl: gateway?.connection.gatewayUrl,
      phase: gateway?.snapshot.phase,
    };
  });
}

suite.define(() => {
  it("blocks empty protected values without rejecting empty environment entries", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["secrets.store.list", "secrets.store.set"],
        methodResponses: {
          "secrets.store.list": {
            sequence: [
              { entries: [secretEntry] },
              { entries: [secretEntry] },
              { entries: [secretEntry] },
            ],
          },
          "secrets.store.set": {
            sequence: [
              { ok: true, reloaded: false },
              { ok: true, reloaded: false },
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/secrets`);
      await page.getByRole("heading", { name: "Secrets" }).waitFor();

      const existingSecretRow = page.getByRole("row", { name: /SERVICE_API_KEY/u });
      await existingSecretRow.getByRole("button", { name: "Actions: SERVICE_API_KEY" }).click();
      await existingSecretRow.locator('wa-dropdown-item[value="edit"]').click();
      const editSecretDialog = page.locator('openclaw-modal-dialog[label="Edit"]');
      await editSecretDialog.getByRole("button", { name: "Save", exact: true }).click();
      await editSecretDialog.getByRole("alert").getByText("Enter a value.").waitFor();
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(0);
      await editSecretDialog.getByRole("button", { name: "Cancel", exact: true }).click();

      await page.getByRole("button", { name: "Add", exact: true }).click();
      const addSecretDialog = page.locator('openclaw-modal-dialog[label="Add"]');
      await addSecretDialog.getByLabel("Name", { exact: true }).fill("EMPTY_API_KEY");
      expect(
        await addSecretDialog.getByRole("radio", { name: /Protected secret/u }).isChecked(),
      ).toBe(true);
      await addSecretDialog.getByRole("button", { name: "Save", exact: true }).click();
      await addSecretDialog.getByRole("alert").getByText("Enter a value.").waitFor();
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(0);
      await capture(page, "04-empty-secret-local-validation.png");
      await addSecretDialog.getByRole("button", { name: "Cancel", exact: true }).click();

      await page.getByRole("button", { name: "Bulk Add", exact: true }).click();
      const protectedBulkDialog = page.locator('openclaw-modal-dialog[label="Bulk Add"]');
      await protectedBulkDialog
        .getByRole("textbox", { name: "Value", exact: true })
        .fill("EMPTY_API_KEY=\nEMPTY_ENV=");
      await protectedBulkDialog.getByText("1 protected secret detected").waitFor();
      await protectedBulkDialog.getByRole("button", { name: "Save", exact: true }).click();
      await protectedBulkDialog
        .getByRole("alert")
        .getByText("EMPTY_API_KEY: Enter a value.")
        .waitFor();
      expect(await gateway.getRequests("secrets.store.set")).toHaveLength(0);
      await capture(page, "05-empty-bulk-local-validation.png");
      await protectedBulkDialog.getByRole("button", { name: "Cancel", exact: true }).click();

      await page.getByRole("button", { name: "Add", exact: true }).click();
      const addEnvDialog = page.locator('openclaw-modal-dialog[label="Add"]');
      await addEnvDialog.getByLabel("Name", { exact: true }).fill("EMPTY_ENV");
      expect(
        await addEnvDialog.getByRole("radio", { name: /Agent-readable environment/u }).isChecked(),
      ).toBe(true);
      await addEnvDialog.getByRole("button", { name: "Save", exact: true }).click();
      await page
        .getByRole("status")
        .getByText(/Saved EMPTY_ENV/u)
        .waitFor();

      await page.getByRole("button", { name: "Bulk Add", exact: true }).click();
      const envBulkDialog = page.locator('openclaw-modal-dialog[label="Bulk Add"]');
      await envBulkDialog
        .getByRole("textbox", { name: "Value", exact: true })
        .fill("EMPTY_BULK_ENV=");
      await envBulkDialog.getByText("0 protected secrets detected").waitFor();
      await envBulkDialog.getByRole("button", { name: "Save", exact: true }).click();
      await page
        .getByRole("status")
        .getByText(/Saved 1 entries/u)
        .waitFor();

      expect(await gateway.getRequests("secrets.store.set")).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({ name: "EMPTY_ENV", value: "", kind: "env" }),
        }),
        expect.objectContaining({
          params: { name: "EMPTY_BULK_ENV", value: "", kind: "env" },
        }),
      ]);
    });
  });

  it("adds env and secret values, bulk imports, and deletes without revealing secrets", async () => {
    if (captureUiProofEnabled) {
      await mkdir(proofDir, { recursive: true });
    }
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
        ...(captureUiProofEnabled
          ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1440 } } }
          : {}),
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
                { ok: true, reloaded: true, warningCount: 2 },
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
        await addDialog.getByText("Agent-readable environment", { exact: true }).waitFor();
        expect(
          await addDialog.getByRole("radio", { name: /Agent-readable environment/u }).isChecked(),
        ).toBe(true);
        await addDialog.getByText(/The agent can print, transmit, or persist it/u).waitFor();
        await addDialog.getByLabel("Name", { exact: true }).fill("SERVICE_URL");
        await addDialog.getByLabel("Value", { exact: true }).fill("https://service.test");
        await capture(page, "02-add-dialog.png", addDialog.locator("dialog"), [
          addDialog.getByLabel("Value", { exact: true }),
        ]);
        await addDialog.getByRole("button", { name: "Save", exact: true }).click();
        await page
          .getByRole("status")
          .getByText(
            "Saved SERVICE_URL as Agent-readable environment. It is available to Gateway-hosted agent commands from the next run.",
          )
          .waitFor();

        await page.getByRole("button", { name: "Add", exact: true }).click();
        const secretDialog = page.locator('openclaw-modal-dialog[label="Add"]');
        await secretDialog.getByLabel("Name", { exact: true }).fill("SERVICE_API_KEY");
        expect(
          await secretDialog.getByRole("radio", { name: /Protected secret/u }).isChecked(),
        ).toBe(true);
        await secretDialog.getByLabel("Value", { exact: true }).fill("super-secret-material");
        await secretDialog.locator('textarea[name="allowed-hosts"]').fill("api.example.com");
        await capture(page, "02-secret-allowed-hosts.png", secretDialog.locator("dialog"), [
          secretDialog.locator('textarea[name="allowed-hosts"]'),
        ]);
        await secretDialog.getByLabel("Name", { exact: true }).press("Enter");
        await page
          .getByRole("status")
          .getByText(
            "Saved SERVICE_API_KEY as Protected secret. Add a SecretRef or enable destination-bound Gateway egress to use it. 2 runtime warnings.",
          )
          .waitFor();
        expect(await page.content()).not.toContain("super-secret-material");
        await page.getByRole("columnheader", { name: "Access" }).waitFor();
        expect(await page.getByRole("row", { name: /SERVICE_URL/u }).textContent()).toContain(
          "Agent-readable environment",
        );
        expect(await page.getByRole("row", { name: /SERVICE_API_KEY/u }).textContent()).toContain(
          "Protected secret",
        );
        expect(await page.getByRole("row", { name: /SERVICE_API_KEY/u }).textContent()).toContain(
          "api.example.com",
        );

        await page.getByRole("button", { name: "Bulk Add", exact: true }).click();
        const bulkDialog = page.locator('openclaw-modal-dialog[label="Bulk Add"]');
        await bulkDialog
          .getByRole("textbox", { name: "Value", exact: true })
          .fill('BULK_PRIVATE_KEY="line one\nline two"\nBULK_URL=https://bulk.test');
        await bulkDialog.getByText("1 protected secret detected").waitFor();
        await capture(page, "03-bulk-add-dialog.png", bulkDialog.locator("dialog"), [
          bulkDialog.getByRole("textbox", { name: "Value", exact: true }),
        ]);
        await bulkDialog.getByRole("button", { name: "Save", exact: true }).click();
        await page
          .getByRole("status")
          .getByText(
            "Saved 2 entries (1 protected, 1 agent-readable). Protected secrets need a SecretRef or enabled destination-bound Gateway egress; agent-readable environment values reach Gateway-hosted agent commands from the next run.",
          )
          .waitFor();

        const bulkRow = page.getByRole("row", { name: /BULK_URL/u });
        await bulkRow.getByRole("button", { name: "Actions: BULK_URL" }).click();
        await bulkRow.locator('wa-dropdown-item[value="delete"]').click();
        const confirm = page.locator('openclaw-modal-dialog[label="Delete"]');
        await confirm.getByRole("button", { name: "Delete", exact: true }).click();
        await page.getByRole("status").getByText("Deleted BULK_URL.").waitFor();
        expect(await page.getByRole("row", { name: /BULK_URL/u }).count()).toBe(0);

        expect(await gateway.getRequests("secrets.store.set")).toHaveLength(4);
        expect((await gateway.getRequests("secrets.store.set"))[1]?.params).toMatchObject({
          name: "SERVICE_API_KEY",
          allowedHosts: ["api.example.com"],
        });
        expect(await gateway.getRequests("secrets.store.delete")).toHaveLength(1);
        expect(await page.content()).not.toContain("super-secret-material");
        expect(await tableBodyContrast(page)).toBeGreaterThanOrEqual(9.5);
        await capture(page, "01-populated-dark.png");
      },
    );
  });

  it("rejects a confirmed deletion after same-URL credentials replace the Gateway client", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["secrets.store.list", "secrets.store.delete"],
        methodResponses: {
          "secrets.store.list": {
            sequence: [{ entries: [envEntry] }, { entries: [envEntry] }, { entries: [] }],
          },
          "secrets.store.delete": { ok: true, reloaded: false },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/secrets`);
      const entryRow = page.getByRole("row", { name: /SERVICE_URL/u });
      await entryRow.getByRole("button", { name: "Actions: SERVICE_URL" }).click();
      await entryRow.locator('wa-dropdown-item[value="delete"]').click();
      const confirmation = page.locator('openclaw-modal-dialog[label="Delete"]');
      await confirmation.getByText("Delete SERVICE_URL?", { exact: true }).waitFor();

      const socketCount = await gateway.getSocketCount();
      const listCount = (await gateway.getRequests("secrets.store.list")).length;
      const originalGateway = await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              gateway: {
                connection: { gatewayUrl: string };
                connect: (options: { token: string }) => void;
                snapshot: { client: { instanceId: string } | null };
              };
            };
          };
        };
        const activeGateway = app.runtime?.context.gateway;
        const client = activeGateway?.snapshot.client;
        if (!activeGateway || !client) {
          throw new Error("Expected a connected Gateway client before confirmation");
        }
        const identity = {
          clientInstanceId: client.instanceId,
          gatewayUrl: activeGateway.connection.gatewayUrl,
        };
        activeGateway.connect({ token: "replacement-secret-delete-proof" });
        return identity;
      });
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await expect
        .poll(async () => (await gateway.getRequests("secrets.store.list")).length)
        .toBeGreaterThan(listCount);
      await expect
        .poll(() => activeGatewayIdentity(page))
        .toMatchObject({
          gatewayUrl: originalGateway.gatewayUrl,
          phase: "connected",
        });
      const replacementGateway = await activeGatewayIdentity(page);
      expect(replacementGateway.clientInstanceId).not.toBe(originalGateway.clientInstanceId);
      await expect
        .poll(() => entryRow.getByRole("button", { name: "Actions: SERVICE_URL" }).isEnabled())
        .toBe(true);

      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

      await expect
        .poll(async () => ({
          alerts: await page.getByRole("alert").count(),
          deletes: (await gateway.getRequests("secrets.store.delete")).length,
        }))
        .not.toEqual({ alerts: 0, deletes: 0 });
      expect(await gateway.getRequests("secrets.store.delete")).toHaveLength(0);
      await page
        .getByRole("alert")
        .getByText("The secret was not deleted. Reload the list and try again.", { exact: true })
        .waitFor();
      await capture(page, "06-client-replacement-delete-rejected.png");
      await entryRow.waitFor();
    });
  });

  it("deletes a confirmed entry after the same Gateway client reconnects", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["secrets.store.list", "secrets.store.delete"],
        methodResponses: {
          "secrets.store.list": {
            sequence: [{ entries: [envEntry] }, { entries: [envEntry] }, { entries: [] }],
          },
          "secrets.store.delete": { ok: true, reloaded: false },
        },
      });

      await page.goto(`${suite.server.baseUrl}settings/secrets`);
      const entryRow = page.getByRole("row", { name: /SERVICE_URL/u });
      await entryRow.getByRole("button", { name: "Actions: SERVICE_URL" }).click();
      await entryRow.locator('wa-dropdown-item[value="delete"]').click();
      const confirmation = page.locator('openclaw-modal-dialog[label="Delete"]');
      await confirmation.getByText("Delete SERVICE_URL?", { exact: true }).waitFor();

      const originalGateway = await activeGatewayIdentity(page);
      const socketCount = await gateway.getSocketCount();
      const listCount = (await gateway.getRequests("secrets.store.list")).length;
      await gateway.closeLatest(1012, "secret delete confirmation reconnect proof");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await expect
        .poll(async () => (await gateway.getRequests("secrets.store.list")).length)
        .toBeGreaterThan(listCount);
      await expect
        .poll(() => activeGatewayIdentity(page))
        .toMatchObject({
          clientInstanceId: originalGateway.clientInstanceId,
          gatewayUrl: originalGateway.gatewayUrl,
          phase: "connected",
        });

      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

      await expect
        .poll(async () => (await gateway.getRequests("secrets.store.delete")).length)
        .toBe(1);
      await expect.poll(() => entryRow.count()).toBe(0);
    });
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
