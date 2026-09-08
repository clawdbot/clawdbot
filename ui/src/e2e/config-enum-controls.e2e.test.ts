import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings enum controls" });

function enumMocks() {
  const config = {
    laboratory: {
      choices: ["alpha", "beta"],
      requiredMode: null,
      optionalMode: null,
      unionMode: null,
      largeMode: null,
    },
  };
  const nullableMode = {
    type: ["string", "null"],
    enum: ["fixed", "other", null],
  };
  return {
    "config.get": {
      appliedConfigHash: "enum-controls",
      config,
      configRevisionHash: "enum-controls",
      hash: "enum-controls",
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    },
    "config.schema": {
      schema: {
        type: "object",
        properties: {
          laboratory: {
            type: "object",
            required: ["requiredMode"],
            properties: {
              choices: {
                type: "array",
                title: "Unique choices",
                uniqueItems: true,
                items: { type: "string", enum: ["alpha", "beta", "gamma"] },
              },
              requiredMode: { ...nullableMode, title: "Required mode" },
              optionalMode: { ...nullableMode, title: "Optional mode" },
              unionMode: {
                title: "Union mode",
                anyOf: [{ const: "fixed" }, { const: "other" }, { type: "null" }],
              },
              largeMode: {
                ...nullableMode,
                title: "Large mode",
                enum: ["fixed", "other", "third", "fourth", "fifth", "sixth", null],
              },
            },
          },
        },
      },
      uiHints: {},
      version: "enum-controls",
    },
  };
}

suite.define(() => {
  it("restores rejected segmented selections for pointer and keyboard edits", async () => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        recordVideo: { dir: suite.artifactDir },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { methodResponses: enumMocks() });
        await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
        const second = page.locator(".cfg-array wa-radio-group").nth(1);
        const selected = () =>
          second
            .locator("wa-radio")
            .evaluateAll((radios) =>
              radios
                .filter((radio) => (radio as HTMLElement & { checked: boolean }).checked)
                .map((radio) => radio.textContent?.trim()),
            );
        await expect.poll(selected).toEqual(["beta"]);
        await second.getByRole("radio", { name: "alpha", exact: true }).click();
        await page.screenshot({ path: path.join(suite.artifactDir, "rejected-pointer.png") });
        await expect.poll(selected).toEqual(["beta"]);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);

        await second.getByRole("radio", { name: "beta", exact: true }).focus();
        await page.keyboard.press("ArrowLeft");
        await expect.poll(selected).toEqual(["beta"]);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);

        await second.getByRole("radio", { name: "gamma", exact: true }).click();
        const request = await gateway.waitForRequest("config.set");
        const submitted = JSON.parse((request.params as { raw: string }).raw);
        expect(submitted.laboratory.choices).toEqual(["alpha", "gamma"]);
        await expect.poll(selected).toEqual(["gamma"]);
        await page.screenshot({ path: path.join(suite.artifactDir, "accepted-selection.png") });
      },
    );
  });

  it("round-trips explicit null separately from unset through analyzed enum fields", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { methodResponses: enumMocks() });
      await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
      await page
        .locator(".settings-row__title")
        .getByText("Required mode", { exact: true })
        .waitFor();
      await page.screenshot({ path: path.join(suite.artifactDir, "nullable-enums.png") });

      for (const [name, key] of [
        ["Required mode", "requiredMode"],
        ["Optional mode", "optionalMode"],
        ["Union mode", "unionMode"],
        ["Large mode", "largeMode"],
      ] as const) {
        const field = page.getByRole("combobox", { name, exact: true });
        await expect.poll(() => field.count()).toBe(1);
        expect(await field.inputValue()).toBe("__null__");
        const before = (await gateway.getRequests("config.set")).length;
        await field.selectOption({ label: "fixed" });
        await gateway.waitForRequest("config.set", { after: before });
        await expect.poll(() => field.isEnabled()).toBe(true);
        await field.selectOption("__null__");
        const restored = await gateway.waitForRequest("config.set", { after: before + 1 });
        const submitted = JSON.parse((restored.params as { raw: string }).raw);
        expect(submitted.laboratory[key]).toBeNull();
        await expect.poll(() => field.isEnabled()).toBe(true);
      }
      const required = page.getByRole("combobox", { name: "Required mode", exact: true });
      expect(await required.locator('option[value="__unset__"]').isDisabled()).toBe(true);
      const optional = page.getByRole("combobox", { name: "Optional mode", exact: true });
      const before = (await gateway.getRequests("config.set")).length;
      await optional.selectOption("__unset__");
      const cleared = await gateway.waitForRequest("config.set", { after: before });
      const submitted = JSON.parse((cleared.params as { raw: string }).raw);
      expect(submitted.laboratory).not.toHaveProperty("optionalMode");
    });
  });

  it("names the message-width textbox with its visible setting title", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const width = page.locator("[data-settings-chat-message-width]");
      await width.waitFor();
      await width.scrollIntoViewIfNeeded();
      await writeFile(
        path.join(suite.artifactDir, "message-width-accessibility.yml"),
        await width.ariaSnapshot(),
      );
      await page.screenshot({ path: path.join(suite.artifactDir, "message-width.png") });
      const namedWidth = page.getByRole("textbox", { name: "Message width", exact: true });
      await expect.poll(() => namedWidth.count()).toBe(1);
      await namedWidth.fill("64rem");
      await namedWidth.blur();
      await page.reload();
      await expect.poll(() => namedWidth.inputValue()).toBe("64rem");
    });
  });
});
