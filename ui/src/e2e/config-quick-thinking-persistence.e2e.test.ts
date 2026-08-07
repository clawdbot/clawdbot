// Control UI tests cover shared model-behavior persistence through the mocked Gateway.
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Models settings behavior persistence mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

function configResponse(
  thinkingDefault: "low" | "high",
  hash: string,
  fastModeDefault?: boolean | "auto",
) {
  const config = {
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        thinkingDefault,
        ...(fastModeDefault === undefined ? {} : { fastModeDefault }),
      },
    },
  };
  return {
    config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected config.set params");
  }
  return JSON.parse(String((params as Record<string, unknown>).raw)) as Record<string, unknown>;
}

suite.define(() => {
  it("redirects the legacy General model deep link to Models", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page);

        const response = await page.goto(
          `${suite.server.baseUrl}settings/general#settings-general-model`,
        );
        expect(response?.status()).toBe(200);

        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
      },
    );
  });

  it("reads and writes only agents.defaults.thinkingDefault", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ context, page }) => {
        const initialConfig = configResponse("low", "hash-1");
        const savedConfig = configResponse("high", "hash-2");
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": initialConfig,
            "config.set": savedConfig,
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        expect(response?.status()).toBe(200);

        const modelCard = page.locator("#settings-model-behavior");
        const lowButton = modelCard.getByRole("radio", { name: "Low", exact: true });
        await lowButton.waitFor();
        expect(await lowButton.getAttribute("aria-checked")).toBe("true");

        await modelCard.getByRole("radio", { name: "High", exact: true }).click();

        const raw = requestRaw(await gateway.waitForRequest("config.set"));
        expect(raw).toEqual({
          agents: { defaults: { model: "openai/gpt-5.5", thinkingDefault: "high" } },
        });
        expect(JSON.stringify(raw)).not.toContain("thinkingLevel");
        expect(JSON.stringify(raw)).not.toContain("fastMode");

        const freshPage = await context.newPage();
        await installMockGateway(freshPage, {
          methodResponses: { "config.get": savedConfig },
        });
        await freshPage.goto(`${suite.server.baseUrl}settings/model-providers`);
        const highButton = freshPage
          .locator("#settings-model-behavior")
          .getByRole("radio", { name: "High", exact: true });
        await highButton.waitFor();
        expect(await highButton.getAttribute("aria-checked")).toBe("true");
      },
    );
  });

  it.each([
    { initial: false, initialLabel: "Standard", next: true, nextLabel: "Fast" },
    { initial: true, initialLabel: "Fast", next: "auto" as const, nextLabel: "Auto" },
    { initial: "auto" as const, initialLabel: "Auto", next: false, nextLabel: "Standard" },
  ])(
    "persists agents.defaults.fastModeDefault from $initialLabel to $nextLabel",
    async ({ initial, initialLabel, next, nextLabel }) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        async ({ page }) => {
          const initialConfig = configResponse("low", "hash-1", initial);
          const gateway = await installMockGateway(page, {
            methodResponses: { "config.get": initialConfig },
          });

          const response = await page.goto(`${suite.server.baseUrl}settings/model-providers`);
          expect(response?.status()).toBe(200);

          const modelCard = page.locator("#settings-model-behavior");
          const initialButton = modelCard.getByRole("radio", { name: initialLabel, exact: true });
          await initialButton.waitFor();
          expect(await initialButton.getAttribute("aria-checked")).toBe("true");

          await modelCard.getByRole("radio", { name: nextLabel, exact: true }).click();

          const raw = requestRaw(await gateway.waitForRequest("config.set"));
          expect(raw).toEqual({
            agents: {
              defaults: {
                model: "openai/gpt-5.5",
                thinkingDefault: "low",
                fastModeDefault: next,
              },
            },
          });
          expect(raw.agents).not.toHaveProperty("defaults.fastMode");

          const reloadResponse = await page.reload();
          expect(reloadResponse?.status()).toBe(200);
          const persistedButton = modelCard.getByRole("radio", { name: nextLabel, exact: true });
          await persistedButton.waitFor();
          expect(await persistedButton.getAttribute("aria-checked")).toBe("true");
        },
      );
    },
  );
});
