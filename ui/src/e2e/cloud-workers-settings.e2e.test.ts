import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  installMockGateway,
  type MockGatewayRequest,
  waitForConfirmModal,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForSettledFormControls } from "./settle.test-support.ts";

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

function configuredCloudWorkerProfile(backend = "aws") {
  return {
    provider: "crabbox",
    install: "bundle",
    settings: {
      provider: backend,
      class: "standard",
      ttl: "8h",
      idleTimeout: "45m",
    },
  };
}

function requestRaw(request: MockGatewayRequest): Record<string, unknown> {
  if (!isRecord(request.params) || typeof request.params.raw !== "string") {
    throw new Error("Expected config.patch params");
  }
  const parsed: unknown = JSON.parse(request.params.raw);
  if (!isRecord(parsed)) {
    throw new Error("Expected config.patch raw object");
  }
  return parsed;
}

async function waitForConfigPatch(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  previousCount: number,
): Promise<Record<string, unknown>> {
  await expect.poll(() => gateway.getRequests("config.patch")).toHaveLength(previousCount + 1);
  const request = (await gateway.getRequests("config.patch"))[previousCount];
  if (!request) {
    throw new Error("Expected next config.patch request");
  }
  return requestRaw(request);
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
          profiles: [
            {
              id: "build-fleet",
              providerId: "crabbox",
              machines: [
                { id: "standard", label: "Standard", default: true },
                { id: "fast", label: "Fast" },
              ],
            },
          ],
        },
      },
    });

    try {
      expect((await page.goto(`${suite.server.baseUrl}settings/cloud-workers`))?.status()).toBe(
        200,
      );
      const docsLink = page.getByRole("link", { name: "Learn more", exact: true });
      await docsLink.waitFor();
      expect(await docsLink.getAttribute("href")).toBe(
        "https://docs.openclaw.ai/gateway/cloud-workers",
      );
      await gateway.waitForRequest("environments.list");
      await page.getByText("No cloud worker profiles are configured.", { exact: true }).waitFor();

      await page.getByRole("button", { name: "Add profile" }).click();
      expect(await page.getByRole("combobox", { name: "Machine class", exact: true }).count()).toBe(
        0,
      );
      await page.getByLabel("Profile ID").fill("build-fleet");
      await page.getByLabel("Crabbox backend").fill("hetzner");
      await waitForSettledFormControls(page, [
        { locator: page.getByLabel("Profile ID"), value: "build-fleet" },
        { locator: page.getByLabel("Crabbox backend"), value: "hetzner" },
      ]);
      const machineClass = page.getByRole("textbox", { name: "Machine class", exact: true });
      await expect.poll(() => machineClass.inputValue()).toBe("");
      expect(await machineClass.getAttribute("list")).toBeNull();
      expect(
        await page
          .locator("openclaw-cloud-workers-page datalist, openclaw-cloud-workers-page option")
          .count(),
      ).toBe(0);
      for (const invalidClass of ["", " ", "x".repeat(129)]) {
        await machineClass.fill(invalidClass);
        await waitForSettledFormControls(page, [{ locator: machineClass, value: invalidClass }]);
        await page.getByRole("button", { name: "Save" }).click();
        await expect
          .poll(() => page.getByRole("alert").textContent())
          .toBe("Enter a machine class of 1 to 128 characters.");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      }
      await machineClass.fill("standard");
      await waitForSettledFormControls(page, [{ locator: machineClass, value: "standard" }]);
      await gateway.deferNext("config.patch");
      const addRequestCount = (await gateway.getRequests("config.patch")).length;
      await page.getByRole("button", { name: "Save" }).click();
      const addPatch = await waitForConfigPatch(gateway, addRequestCount);
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
      // The saved snapshot includes provider-owned fields absent from this editor.
      const buildFleet = {
        provider: "crabbox",
        install: "bundle",
        label: "Build fleet",
        settings: {
          provider: "hetzner",
          class: "standard",
          ttl: "8h",
          idleTimeout: "45m",
          region: "eu-west-1",
          resources: { cpu: 6, memoryGiB: 12 },
          providerOptions: { image: "qa-base" },
        },
      };
      // Keep the mocked config.get consistent with the patch response: the
      // config store may reconcile with a refetch, and a stale empty config
      // would flap the snapshot and silently drop the next save.
      await gateway.setMethodResponse(
        "config.get",
        configResponse(
          { cloudWorkers: { profiles: { "build-fleet": buildFleet } } },
          "cloud-workers-2",
        ),
      );
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        hash: "cloud-workers-2",
        config: { cloudWorkers: { profiles: { "build-fleet": buildFleet } } },
      });

      await page.getByText("Advertised", { exact: true }).waitFor();
      await page.getByText("Gateway restart required.", { exact: true }).waitFor();

      await page.getByRole("button", { name: "Edit" }).click();
      await expect.poll(() => machineClass.inputValue()).toBe("standard");
      await machineClass.fill("batch/ARM64.v2");
      await page.getByLabel("Crabbox backend").fill("daytona");
      await page.getByLabel("Max lifetime").fill("12h");
      await page
        .locator(".settings-row")
        .filter({ hasText: "Desktop" })
        .locator("wa-switch")
        .click();
      await page.getByLabel("Crabbox binary").fill("/opt/bin/crabbox-draft");
      await waitForSettledFormControls(page, [
        { locator: machineClass, value: "batch/ARM64.v2" },
        { locator: page.getByLabel("Crabbox backend"), value: "daytona" },
        { locator: page.getByLabel("Max lifetime"), value: "12h" },
        {
          locator: page.getByRole("switch", { name: "Desktop", exact: true }),
          checked: true,
        },
        { locator: page.getByLabel("Crabbox binary"), value: "/opt/bin/crabbox-draft" },
      ]);
      expect(await page.getByRole("combobox", { name: "Machine class", exact: true }).count()).toBe(
        0,
      );
      expect(await machineClass.getAttribute("list")).toBeNull();
      const saveButton = page.getByRole("button", { name: "Save" });
      // The patch schedules an applied-revision poll. Let it settle before
      // deferring config.get so the background read cannot consume the gate.
      await expect
        .poll(() => page.getByRole("button", { name: "Apply changes", exact: true }).count())
        .toBe(0);
      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("config.get");
      await gateway.emitGatewayEvent("config.changed", {
        path: "/tmp/openclaw.json",
        hash: "cloud-workers-2",
        ts: Date.now(),
      });
      await gateway.waitForRequest("config.get", { after: configGetCount });
      await expect.poll(() => saveButton.isDisabled()).toBe(true);
      await gateway.resolveDeferred(
        "config.get",
        configResponse(
          { cloudWorkers: { profiles: { "build-fleet": buildFleet } } },
          "cloud-workers-2",
        ),
      );
      await expect.poll(() => saveButton.isEnabled()).toBe(true);
      await gateway.deferNext("config.patch");
      const editRequestCount = (await gateway.getRequests("config.patch")).length;
      await saveButton.click();
      const editPatch = await waitForConfigPatch(gateway, editRequestCount);
      expect(editPatch).toEqual({
        cloudWorkers: {
          profiles: {
            "build-fleet": {
              ...buildFleet,
              settings: {
                ...buildFleet.settings,
                provider: "daytona",
                class: "batch/ARM64.v2",
                ttl: "12h",
                idleTimeout: "45m",
                setup: null,
                desktop: true,
                binary: "/opt/bin/crabbox-draft",
              },
            },
          },
        },
      });
      const editedFleet = {
        ...buildFleet,
        settings: {
          ...buildFleet.settings,
          provider: "daytona",
          class: "batch/ARM64.v2",
          ttl: "12h",
          idleTimeout: "45m",
          desktop: true,
          binary: "/opt/bin/crabbox-draft",
        },
      };
      // Keep the mocked config.get consistent with the patch response: the
      // config store may reconcile with a refetch, and a stale empty config
      // would flap the snapshot and silently drop the next save.
      await gateway.setMethodResponse(
        "config.get",
        configResponse(
          { cloudWorkers: { profiles: { "build-fleet": editedFleet } } },
          "cloud-workers-3",
        ),
      );
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        hash: "cloud-workers-3",
        config: { cloudWorkers: { profiles: { "build-fleet": editedFleet } } },
      });

      await page.getByText("Class: batch/ARM64.v2", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await waitForSettledFormControls(page, [
        { locator: machineClass, value: "batch/ARM64.v2" },
        { locator: page.getByLabel("Crabbox backend"), value: "daytona" },
        { locator: page.getByLabel("Crabbox binary"), value: "/opt/bin/crabbox-draft" },
      ]);
      await page.getByRole("button", { name: "Cancel" }).click();

      await page.getByRole("button", { name: "Add profile" }).click();
      await page.getByLabel("Profile ID").fill("pending");
      await page.getByLabel("Crabbox backend").fill("aws");
      await machineClass.fill("custom");
      await waitForSettledFormControls(page, [
        { locator: page.getByLabel("Profile ID"), value: "pending" },
        { locator: page.getByLabel("Crabbox backend"), value: "aws" },
        { locator: machineClass, value: "custom" },
      ]);
      await gateway.deferNext("config.patch");
      const pendingRequestCount = (await gateway.getRequests("config.patch")).length;
      await page.getByRole("button", { name: "Save" }).click();
      const pendingPatch = await waitForConfigPatch(gateway, pendingRequestCount);
      expect(pendingPatch).toMatchObject({
        cloudWorkers: {
          profiles: {
            "build-fleet": editedFleet,
            pending: {
              provider: "crabbox",
              install: "bundle",
              settings: { provider: "aws", class: "custom" },
            },
          },
        },
      });
      const pending = {
        provider: "crabbox",
        install: "bundle",
        settings: {
          provider: "aws",
          class: "custom",
          ttl: "8h",
          idleTimeout: "45m",
        },
      };
      await gateway.setMethodResponse(
        "config.get",
        configResponse(
          { cloudWorkers: { profiles: { "build-fleet": editedFleet, pending } } },
          "cloud-workers-4",
        ),
      );
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        hash: "cloud-workers-4",
        config: {
          cloudWorkers: { profiles: { "build-fleet": editedFleet, pending } },
        },
      });
      await page.getByText("Restart required", { exact: true }).waitFor();
      await page
        .locator(".settings-row")
        .filter({
          has: page.locator("code", { hasText: /^pending$/ }),
        })
        .getByRole("button", { name: "Edit", exact: true })
        .click();
      await expect.poll(() => machineClass.inputValue()).toBe("custom");
    } finally {
      await context.close();
    }
  });

  it("releases a retired profile save after reconnect while preserving the draft", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1_000, width: 1_440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["config.patch", "environments.list"],
      methodResponses: {
        "config.get": configResponse({}, "cloud-workers-reconnect-1"),
        "environments.list": { environments: [], profiles: [] },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      await page.getByRole("button", { name: "Add profile" }).click();
      const editor = page.locator(".settings-section", {
        has: page.getByRole("heading", { name: "Add profile", exact: true }),
      });
      const profileId = page.getByLabel("Profile ID");
      const backend = page.getByLabel("Crabbox backend");
      await profileId.fill("reconnect-proof");
      await backend.fill("hetzner");
      await page.getByLabel("Machine class", { exact: true }).fill("standard");
      await waitForSettledFormControls(page, [
        { locator: profileId, value: "reconnect-proof" },
        { locator: backend, value: "hetzner" },
        { locator: page.getByLabel("Machine class", { exact: true }), value: "standard" },
      ]);

      await gateway.deferNext("config.patch");
      await editor.getByRole("button", { name: "Save" }).click();
      await gateway.waitForRequest("config.patch");
      await expect.poll(() => profileId.isDisabled()).toBe(true);

      const socketCount = await gateway.getSocketCount();
      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse(
        "config.get",
        configResponse({}, "cloud-workers-reconnect-2"),
      );
      await gateway.closeLatest(1012, "cloud worker save reconnect proof");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(configGetCount);

      await expect.poll(() => profileId.isEnabled()).toBe(true);
      await expect.poll(() => backend.isEnabled()).toBe(true);
      await expect.poll(() => profileId.inputValue()).toBe("reconnect-proof");
      await expect.poll(() => backend.inputValue()).toBe("hetzner");
      await expect.poll(() => editor.getByRole("button", { name: "Save" }).isEnabled()).toBe(true);
      await expect
        .poll(() => editor.getByRole("button", { name: "Cancel" }).isEnabled())
        .toBe(true);

      await gateway.resolveDeferred("config.patch", {
        ok: true,
        hash: "retired-cloud-workers-save",
        config: {},
      });
      await expect.poll(() => profileId.inputValue()).toBe("reconnect-proof");
      await expect.poll(() => page.getByText("Gateway restart required.").count()).toBe(0);
      await expect.poll(() => page.getByRole("alert").count()).toBe(0);

      await gateway.deferNext("config.patch");
      const retryRequestCount = (await gateway.getRequests("config.patch")).length;
      await editor.getByRole("button", { name: "Save" }).click();
      const retryPatch = await waitForConfigPatch(gateway, retryRequestCount);
      expect(retryPatch).toMatchObject({
        cloudWorkers: {
          profiles: {
            "reconnect-proof": {
              provider: "crabbox",
              settings: { provider: "hetzner" },
            },
          },
        },
      });
      const savedProfile = {
        provider: "crabbox",
        install: "bundle",
        settings: {
          provider: "hetzner",
          class: "standard",
          ttl: "8h",
          idleTimeout: "45m",
        },
      };
      await gateway.setMethodResponse(
        "config.get",
        configResponse(
          { cloudWorkers: { profiles: { "reconnect-proof": savedProfile } } },
          "cloud-workers-reconnect-3",
        ),
      );
      await gateway.resolveDeferred("config.patch", {
        ok: true,
        hash: "cloud-workers-reconnect-3",
        config: { cloudWorkers: { profiles: { "reconnect-proof": savedProfile } } },
      });
      await page.getByText("Gateway restart required.", { exact: true }).waitFor();
      await expect.poll(() => page.getByLabel("Profile ID").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("preserves provider-owned editors and deletes profiles plus their project defaults", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const pending = configuredCloudWorkerProfile();
    const retained = configuredCloudWorkerProfile("hetzner");
    const retainedProjectProfiles = { "github.com/acme/retained": "retained" };
    const initialConfig = {
      cloudWorkers: {
        profiles: { pending, retained },
        projectProfiles: {
          "github.com/acme/app": "pending",
          "github.com/acme/docs": "pending",
          ...retainedProjectProfiles,
        },
      },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["config.patch", "config.schema", "environments.list"],
      methodResponses: {
        "config.get": configResponse(initialConfig, "cloud-workers-delete-1"),
        "config.schema": {
          version: "e2e",
          generatedAt: "2026-08-25T00:00:00.000Z",
          uiHints: {},
          schema: {
            type: "object",
            properties: {
              cloudWorkers: {
                type: "object",
                properties: {
                  profiles: {
                    type: "object",
                    additionalProperties: { type: "object" },
                  },
                },
              },
            },
          },
        },
        "config.patch": {
          ok: true,
          hash: "cloud-workers-delete-2",
          config: {
            cloudWorkers: { profiles: { retained }, projectProfiles: retainedProjectProfiles },
          },
        },
        "environments.list": { environments: [], profiles: [] },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/cloud-workers`);
      const pendingRow = page.locator(".settings-row").filter({
        has: page.locator("code", { hasText: /^pending$/ }),
      });
      await pendingRow.getByRole("button", { name: "Edit" }).click();
      const editor = page.locator(".settings-section", {
        has: page.getByRole("heading", { name: "Edit profile", exact: true }),
      });
      await expect.poll(() => page.getByLabel("Crabbox backend").inputValue()).toBe("aws");

      const replacement = {
        provider: "static-ssh",
        install: "bundle",
        settings: {
          host: "worker.example.test",
          user: "openclaw",
          keyRef: { source: "env", provider: "default", id: "QA_PRIVATE_KEY" },
        },
      };
      const replacedConfig = {
        cloudWorkers: {
          profiles: { pending: replacement, retained },
          projectProfiles: initialConfig.cloudWorkers.projectProfiles,
        },
      };
      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse(
        "config.get",
        configResponse(replacedConfig, "cloud-workers-provider-replaced"),
      );
      await gateway.emitGatewayEvent("config.changed", {
        path: "/tmp/openclaw.json",
        hash: "cloud-workers-provider-replaced",
        ts: Date.now(),
      });
      await gateway.waitForRequest("config.get", { after: configGetCount });
      await pendingRow.getByText("Provider: static-ssh", { exact: true }).waitFor();
      const saveButton = editor.getByRole("button", { name: "Save" });
      await expect.poll(() => saveButton.isEnabled()).toBe(true);
      await saveButton.click();
      await expect
        .poll(() => editor.getByRole("alert").textContent())
        .toBe("This profile changed or was removed. Reload the page and try again.");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await editor.getByRole("button", { name: "Cancel" }).click();

      await pendingRow.getByRole("button", { name: "Edit" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/advanced");
      await expect.poll(() => new URL(page.url()).searchParams.get("section")).toBe("cloudWorkers");
      await gateway.waitForRequest("config.schema");
      await page.locator(".page-title").getByText("Advanced", { exact: true }).waitFor();
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await page.goBack();
      await pendingRow.getByText("Provider: static-ssh", { exact: true }).waitFor();

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
        cloudWorkers: {
          profiles: { pending: null, retained },
          projectProfiles: { "github.com/acme/app": null, "github.com/acme/docs": null },
        },
      });
      await expect.poll(() => pendingRow.count()).toBe(0);
      await page.locator(".settings-row code", { hasText: /^retained$/ }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("deletes a confirmed profile after the Gateway reconnects during confirmation", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const pending = configuredCloudWorkerProfile();
    const initialConfig = { cloudWorkers: { profiles: { pending } } };
    const gateway = await installMockGateway(page, {
      featureMethods: ["config.patch", "environments.list"],
      methodResponses: {
        "config.get": configResponse(initialConfig, "cloud-workers-delete-reconnect-1"),
        "config.patch": {
          ok: true,
          hash: "cloud-workers-delete-reconnect-3",
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
      const socketCount = await gateway.getSocketCount();
      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse(
        "config.get",
        configResponse(initialConfig, "cloud-workers-delete-reconnect-2"),
      );
      await gateway.closeLatest(1012, "cloud worker delete confirmation reconnect proof");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(configGetCount);
      await expect
        .poll(() => pendingRow.getByRole("button", { name: "Delete" }).isEnabled())
        .toBe(true);

      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

      await expect.poll(async () => (await gateway.getRequests("config.patch")).length).toBe(1);
      await expect.poll(() => pendingRow.count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("rejects a confirmed deletion after same-URL Gateway credentials replace its client", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const initialConfig = {
      cloudWorkers: { profiles: { pending: configuredCloudWorkerProfile() } },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["config.patch", "environments.list"],
      methodResponses: {
        "config.get": configResponse(initialConfig, "cloud-workers-delete-client-replacement-1"),
        "config.patch": {
          ok: true,
          hash: "cloud-workers-delete-client-replacement-2",
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
      const socketCount = await gateway.getSocketCount();
      const configGetCount = (await gateway.getRequests("config.get")).length;
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
        activeGateway.connect({ token: "replacement-credential-proof" });
        return identity;
      });
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(configGetCount);
      await expect
        .poll(() =>
          page.evaluate(() => {
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
            const activeGateway = app.runtime?.context.gateway;
            return {
              clientInstanceId: activeGateway?.snapshot.client?.instanceId,
              gatewayUrl: activeGateway?.connection.gatewayUrl,
              phase: activeGateway?.snapshot.phase,
            };
          }),
        )
        .toMatchObject({ gatewayUrl: originalGateway.gatewayUrl, phase: "connected" });
      const replacementClientInstanceId = await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { gateway: { snapshot: { client: { instanceId: string } } } } };
        };
        return app.runtime?.context.gateway.snapshot.client.instanceId;
      });
      expect(replacementClientInstanceId).not.toBe(originalGateway.clientInstanceId);
      await expect
        .poll(() => pendingRow.getByRole("button", { name: "Delete" }).isEnabled())
        .toBe(true);

      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

      await expect
        .poll(async () => ({
          alerts: await page.getByRole("alert").count(),
          patches: (await gateway.getRequests("config.patch")).length,
        }))
        .not.toEqual({ alerts: 0, patches: 0 });
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await expect
        .poll(async () => page.getByRole("alert").textContent())
        .toBe("The profile was not deleted. Reload the config and try again.");
      await pendingRow.waitFor();
    } finally {
      await context.close();
    }
  });

  it("reports a confirmed deletion that cannot run while Gateway config is reconnecting", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const initialConfig = {
      cloudWorkers: { profiles: { pending: configuredCloudWorkerProfile() } },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["config.patch", "environments.list"],
      methodResponses: {
        "config.get": configResponse(initialConfig, "cloud-workers-delete-offline-1"),
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
      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("config.get");
      await gateway.closeLatest(1012, "cloud worker delete unavailable reconnect proof");
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThan(configGetCount);

      await confirmation.getByRole("button", { name: "Delete", exact: true }).click();

      await expect
        .poll(async () => page.getByRole("alert").textContent())
        .toBe("The profile was not deleted. Reload the config and try again.");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await pendingRow.waitFor();
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
