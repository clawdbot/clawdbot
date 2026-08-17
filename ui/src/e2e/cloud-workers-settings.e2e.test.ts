import { expect, it } from "vitest";
import {
  installMockGateway,
  type MockGatewayRequest,
  waitForConfirmModal,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cloud workers settings mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

function configResponse(config: Record<string, unknown>, hash: string) {
  return {
    appliedConfigHash: hash,
    config,
    sourceConfig: config,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    throw new Error("Expected config.patch params");
  }
  return JSON.parse(String((request.params as Record<string, unknown>).raw)) as Record<
    string,
    unknown
  >;
}

suite.define(() => {
  it("adds and edits profiles while distinguishing advertised state", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1_000, width: 1_440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["config.patch", "environments.list"],
      methodResponses: {
        "config.get": configResponse({}, "cloud-workers-1"),
        "environments.list": {
          environments: [],
          profiles: [{ id: "build-fleet", providerId: "crabbox" }],
        },
      },
    });

    try {
      expect((await page.goto(`${suite.server.baseUrl}settings/cloud-workers`))?.status()).toBe(
        200,
      );
      await gateway.waitForRequest("environments.list");
      await page.getByText("No cloud worker profiles are configured.", { exact: true }).waitFor();

      await page.getByRole("button", { name: "Add profile" }).click();
      await page.getByLabel("Profile ID").fill("build-fleet");
      await page.getByLabel("Crabbox backend").fill("hetzner");
      await gateway.deferNext("config.patch");
      await page.getByRole("button", { name: "Save" }).click();
      const addPatch = requestRaw(await gateway.waitForRequest("config.patch"));
      expect(addPatch).toEqual({
        cloudWorkers: {
          profiles: {
            "build-fleet": {
              provider: "crabbox",
              install: "bundle",
              settings: {
                provider: "hetzner",
                class: "standard",
                ttl: "8h",
                idleTimeout: "45m",
                setup: null,
                desktop: null,
                binary: null,
              },
            },
          },
        },
      });
      const buildFleet = {
        provider: "crabbox",
        install: "bundle",
        settings: {
          provider: "hetzner",
          class: "standard",
          ttl: "8h",
          idleTimeout: "45m",
        },
      };
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        hash: "cloud-workers-2",
        config: { cloudWorkers: { profiles: { "build-fleet": buildFleet } } },
      });
      await page.getByText("Advertised", { exact: true }).waitFor();
      await page.getByText("Gateway restart required.", { exact: true }).waitFor();

      await page.getByRole("button", { name: "Edit" }).click();
      await page.getByLabel("Machine class").selectOption("custom");
      await page.getByLabel("Custom machine class").fill("ccx53");
      await page.getByLabel("Max lifetime").fill("12h");
      await page
        .locator(".settings-row")
        .filter({ hasText: "Desktop" })
        .locator("wa-switch")
        .click();
      await page.getByLabel("Crabbox binary").fill("/opt/bin/crabbox");
      await gateway.deferNext("config.patch");
      await page.getByRole("button", { name: "Save" }).click();
      const editPatch = requestRaw(await gateway.waitForRequest("config.patch"));
      expect(editPatch).toMatchObject({
        cloudWorkers: {
          profiles: {
            "build-fleet": {
              provider: "crabbox",
              install: "bundle",
              settings: {
                provider: "hetzner",
                class: "ccx53",
                ttl: "12h",
                idleTimeout: "45m",
                setup: null,
                desktop: true,
                binary: "/opt/bin/crabbox",
              },
            },
          },
        },
      });
      const editedFleet = {
        provider: "crabbox",
        install: "bundle",
        settings: {
          provider: "hetzner",
          class: "ccx53",
          ttl: "12h",
          idleTimeout: "45m",
          desktop: true,
          binary: "/opt/bin/crabbox",
        },
      };
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        hash: "cloud-workers-3",
        config: { cloudWorkers: { profiles: { "build-fleet": editedFleet } } },
      });
      await page.getByText(/Class: ccx53/).waitFor();

      await page.getByRole("button", { name: "Add profile" }).click();
      await page.getByLabel("Profile ID").fill("pending");
      await page.getByLabel("Crabbox backend").fill("aws");
      await gateway.deferNext("config.patch");
      await page.getByRole("button", { name: "Save" }).click();
      const pendingPatch = requestRaw(await gateway.waitForRequest("config.patch"));
      expect(pendingPatch).toMatchObject({
        cloudWorkers: {
          profiles: {
            "build-fleet": editedFleet,
            pending: {
              provider: "crabbox",
              install: "bundle",
              settings: { provider: "aws", class: "standard" },
            },
          },
        },
      });
      const pending = {
        provider: "crabbox",
        install: "bundle",
        settings: {
          provider: "aws",
          class: "standard",
          ttl: "8h",
          idleTimeout: "45m",
        },
      };
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        hash: "cloud-workers-4",
        config: {
          cloudWorkers: { profiles: { "build-fleet": editedFleet, pending } },
        },
      });
      await page.getByText("Restart required", { exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("deletes a profile only after confirmation", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const pending = {
      provider: "crabbox",
      install: "bundle",
      settings: {
        provider: "aws",
        class: "standard",
        ttl: "8h",
        idleTimeout: "45m",
      },
    };
    const initialConfig = { cloudWorkers: { profiles: { pending } } };
    const gateway = await installMockGateway(page, {
      featureMethods: ["config.patch", "environments.list"],
      methodResponses: {
        "config.get": configResponse(initialConfig, "cloud-workers-delete-1"),
        "config.patch": {
          ok: true,
          hash: "cloud-workers-delete-2",
          config: { cloudWorkers: { profiles: {} } },
        },
        "environments.list": { environments: [], profiles: [] },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      const pendingRow = page.locator(".settings-row").filter({
        has: page.locator("code", { hasText: /^pending$/ }),
      });
      await pendingRow.getByRole("button", { name: "Delete" }).click();
      const confirmation = await waitForConfirmModal(page);
      await expect.poll(() => confirmation.textContent()).toContain("Delete profile pending?");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(1);
      const deleteRequest = (await gateway.getRequests("config.patch"))[0];
      if (!deleteRequest) {
        throw new Error("Expected delete config.patch request");
      }
      expect(requestRaw(deleteRequest)).toEqual({
        cloudWorkers: { profiles: { pending: null } },
      });
      await expect.poll(() => pendingRow.count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("keeps profile mutations admin-scoped", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    await installMockGateway(page, {
      operatorScopes: ["operator.read"],
      featureMethods: ["config.patch", "environments.list"],
      methodResponses: {
        "config.get": configResponse({}, "cloud-workers-read-only"),
        "environments.list": { environments: [], profiles: [] },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page
        .getByText("Administrator access is required to manage cloud worker profiles.", {
          exact: true,
        })
        .waitFor();
      expect(await page.getByRole("button", { name: "Add profile" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
