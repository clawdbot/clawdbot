// Control UI tests cover the guided mobile pairing wizard through the mocked Gateway.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import qrcode from "qrcode";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI mobile pairing mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/mobile-pairing");
const LAN_URL = "ws://192.168.1.20:18789";
const BASE_CONFIG_HASH = "mock-config-hash-0";
const LAN_PATCH = '{"gateway":{"bind":"lan"}}';

const loopbackInspection = {
  configHash: BASE_CONFIG_HASH,
  configState: "applied",
  auth: "token",
  current: { status: "blocked", blocker: "route-unavailable" },
  lan: { status: "available", url: LAN_URL, requiresGatewayChange: true },
  tailscale: { status: "unavailable" },
  publicUrl: { status: "not-configured" },
};

const lanPlan = {
  status: "confirmation-required",
  mode: "lan",
  configHash: BASE_CONFIG_HASH,
  configState: "applied",
  urls: [LAN_URL],
  exposure: "local-network",
  auth: "token",
  access: "limited",
  accessDowngraded: true,
  changes: ["expose-gateway-on-local-network"],
  configWrite: {
    patch: LAN_PATCH,
    revert: { execution: "automatic", patch: '{"gateway":{"bind":"loopback"}}' },
  },
  restartRequired: true,
  preservesCurrentRoute: false,
};

const appliedLanPlan = {
  ...lanPlan,
  changes: [],
  restartRequired: false,
  preservesCurrentRoute: true,
  configWrite: undefined,
};

const TAILNET_URL = "wss://gateway.tail1a2b.ts.net";
const TAILSCALE_UNAVAILABLE_COPY = "To use Tailscale, install it on the Gateway host.";

/** Every unhealthy Tailscale state is a manual, resumable Gateway-host step. */
const blockedTailscalePlan = {
  status: "blocked",
  mode: "tailscale",
  configHash: BASE_CONFIG_HASH,
  configState: "applied",
  auth: "token",
  blocker: "tailscale-unavailable",
  changes: [],
  action: { kind: "retry", target: "gateway-host", execution: "manual", resumable: true },
};

const tailscalePlan = {
  status: "confirmation-required",
  mode: "tailscale",
  configHash: BASE_CONFIG_HASH,
  configState: "applied",
  urls: [TAILNET_URL],
  exposure: "tailnet",
  auth: "token",
  access: "full",
  accessDowngraded: false,
  changes: [],
  restartRequired: false,
  preservesCurrentRoute: true,
};

/**
 * Restarts the application connection the way a `gateway.*` change does, and
 * proves the app socket really dropped and was replaced. Counting sockets for
 * the app URL keeps this honest: the endpoint probe opens its own socket, so a
 * bare online toggle could otherwise target the probe and never restart the app.
 */
async function restartGatewayConnection(gateway: MockGatewayControls, page: Page) {
  const appSocketUrl = (await gateway.getSocketUrls())[0];
  if (!appSocketUrl) {
    throw new Error("Expected the Control UI to hold an application socket before the restart");
  }
  const appSockets = async () =>
    (await gateway.getSocketUrls()).filter((url) => url === appSocketUrl).length;
  const before = await appSockets();
  await gateway.setOnline(false);
  // The wizard survives the disconnect its own change caused.
  await page.getByText("Waiting for the Gateway to restart…").waitFor();
  await gateway.setOnline(true);
  await expect.poll(appSockets, { timeout: 20_000 }).toBeGreaterThan(before);
}

/** Waits out the modal's entry animation so captures are not half-faded. */
async function settleDialog(page: Page) {
  await page.waitForFunction(() => {
    const modal = document.querySelector("openclaw-modal-dialog");
    const host = modal?.shadowRoot?.querySelector("wa-dialog");
    const native = host?.shadowRoot?.querySelector("dialog");
    const panel = document.querySelector(".device-pair-setup");
    if (!modal || !host || !native || !panel) {
      return false;
    }
    const opaque = [modal, host, native, panel].every(
      (element) => Number(getComputedStyle(element).opacity) === 1,
    );
    if (!opaque) {
      return false;
    }
    const running = [host, native, panel].flatMap((element) =>
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState !== "finished"),
    );
    return running.length === 0;
  });
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  });
}

const PAIRING_VIEWPORTS = [
  { name: "desktop", height: 900, width: 1280 },
  { name: "mobile", height: 844, width: 390 },
] as const;

suite.define(() => {
  it("plans, applies, survives the restart, and only then issues a setup code", async () => {
    const setupCode = Buffer.from(
      JSON.stringify({ url: LAN_URL, bootstrapToken: "e2e-bootstrap-token" }),
      "utf8",
    ).toString("base64url");
    const qrDataUrl = await qrcode.toDataURL(setupCode, { margin: 2, width: 360 });
    mkdirSync(artifactDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
          methodResponses: {
            "config.get": {
              raw: '{\n  "gateway": { "bind": "loopback" }\n}\n',
              hash: BASE_CONFIG_HASH,
              path: "/tmp/openclaw.json",
              config: { gateway: { bind: "loopback" } },
            },
            "config.patch": { ok: true },
            "device.pair.list": { paired: [], pending: [] },
            "device.pair.connectivity.inspect": loopbackInspection,
            "device.pair.connectivity.plan": lanPlan,
            "device.pair.setupCode": {
              access: "limited",
              accessDowngraded: true,
              auth: "token",
              gatewayUrl: LAN_URL,
              qrDataUrl,
              setupCode,
              urlSource: "gateway.bind=lan",
            },
            "node.list": { nodes: [] },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}chat`);
        expect(response?.status()).toBe(200);

        // Pairing lives with the account-level controls in the footer identity menu.
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.getByRole("button", { name: /^Identity and app menu for / }).click();
        const sidebarPairingButton = sidebar
          .locator("wa-dropdown.sidebar-identity-menu")
          .locator(".sidebar-pair-mobile");
        await sidebarPairingButton.waitFor();
        await expect.poll(async () => sidebarPairingButton.isEnabled()).toBe(true);
        await sidebarPairingButton.click();

        const dialog = page.getByRole("dialog", { name: "OpenClaw mobile" });
        await dialog.waitFor();
        const chooserPrompt = page.getByText("How should this phone reach the Gateway?");
        await chooserPrompt.waitFor();
        await expect
          .poll(async () => (await gateway.getRequests("device.pair.connectivity.inspect")).length)
          .toBe(1);
        expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
        expect(
          await page.getByText("This Gateway has no address a phone can reach yet.").isVisible(),
        ).toBe(true);
        await settleDialog(page);
        await page.screenshot({ path: path.join(artifactDir, "01-chooser.png") });

        await page.getByRole("button", { name: /^Local network/ }).click();
        await page.getByText("Devices on the same local network can reach this Gateway.").waitFor();
        expect(
          await page.getByText("Every device still has to sign in to the Gateway.").isVisible(),
        ).toBe(true);
        expect(
          await page
            .getByText("A plaintext address issues Limited access instead of full control.")
            .isVisible(),
        ).toBe(true);
        expect(
          await page.getByText("This does not put the Gateway on the public internet.").isVisible(),
        ).toBe(true);
        // Nothing is written before the operator confirms the consequences.
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        await settleDialog(page);
        await page.screenshot({ path: path.join(artifactDir, "02-lan-review.png") });

        await page.getByRole("button", { name: "Expose on local network" }).click();
        const patch = await gateway.waitForRequest("config.patch");
        expect(patch.params).toMatchObject({ baseHash: BASE_CONFIG_HASH, raw: LAN_PATCH });
        await page.getByText("Waiting for the Gateway to restart…").waitFor();
        await page.screenshot({ path: path.join(artifactDir, "03-awaiting-restart.png") });

        await gateway.setMethodResponse("device.pair.connectivity.plan", appliedLanPlan);
        await restartGatewayConnection(gateway, page);

        const qr = page.getByAltText("OpenClaw mobile pairing QR code");
        await qr.waitFor({ timeout: 20_000 });
        expect(await qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/u);
        expect(await page.getByText(LAN_URL, { exact: true }).isVisible()).toBe(true);
        // Issuance is pinned to the planned LAN route, not a persisted address.
        expect((await gateway.getRequests("device.pair.setupCode")).map((r) => r.params)).toEqual([
          { mode: "lan" },
        ]);
        // Re-inspection after the restart is what unlocks issuance.
        expect(
          (await gateway.getRequests("device.pair.connectivity.inspect")).length,
        ).toBeGreaterThan(1);
        await settleDialog(page);
        await page.screenshot({ path: path.join(artifactDir, "04-setup-code.png") });

        writeFileSync(
          path.join(artifactDir, "behavior-summary.json"),
          `${JSON.stringify(
            {
              configPatches: (await gateway.getRequests("config.patch")).map(
                (request) => request.params,
              ),
              inspections: (await gateway.getRequests("device.pair.connectivity.inspect")).length,
              setupCodesIssued: (await gateway.getRequests("device.pair.setupCode")).length,
            },
            null,
            2,
          )}\n`,
        );
        expect(pageErrors).toEqual([]);
      },
    );
  });

  it("keeps a rejected public address editable and never mints for it", async () => {
    mkdirSync(artifactDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
          methodResponses: {
            "device.pair.list": { paired: [], pending: [] },
            "device.pair.connectivity.inspect": loopbackInspection,
            "device.pair.connectivity.plan": {
              status: "blocked",
              mode: "public",
              configState: "applied",
              auth: "token",
              blocker: "public-url-insecure",
              changes: [],
            },
            "node.list": { nodes: [] },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/security`);
        await page
          .locator(".security-page")
          .getByRole("button", { name: "Pair mobile device" })
          .click();
        await page.getByRole("dialog", { name: "OpenClaw mobile" }).waitFor();

        await page.getByRole("button", { name: /^Public address/ }).click();
        const input = page.locator('input[name="device-pair-public-url"]');
        await input.waitFor();
        await input.fill("ws://gateway.example.com");
        await settleDialog(page);
        await page.screenshot({ path: path.join(artifactDir, "05-public-url.png") });

        await page.getByRole("button", { name: "Check address" }).click();
        await page.getByText("Public pairing requires a secure wss:// address.").waitFor();
        expect(await input.inputValue()).toBe("ws://gateway.example.com");
        expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        await settleDialog(page);
        await page.screenshot({ path: path.join(artifactDir, "06-public-url-rejected.png") });
        expect(pageErrors).toEqual([]);
      },
    );
  });

  it("keeps an unavailable Tailscale option local, recoverable, and link-free", async () => {
    const setupCode = Buffer.from(
      JSON.stringify({ url: TAILNET_URL, bootstrapToken: "e2e-bootstrap-token" }),
      "utf8",
    ).toString("base64url");
    const qrDataUrl = await qrcode.toDataURL(setupCode, { margin: 2, width: 360 });
    mkdirSync(artifactDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
          methodResponses: {
            "device.pair.list": { paired: [], pending: [] },
            "device.pair.connectivity.inspect": loopbackInspection,
            "device.pair.connectivity.plan": blockedTailscalePlan,
            "device.pair.setupCode": {
              access: "full",
              auth: "token",
              gatewayUrl: TAILNET_URL,
              qrDataUrl,
              setupCode,
              urlSource: "gateway.tailscale.mode=serve",
            },
            "node.list": { nodes: [] },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/security`);
        await page
          .locator(".security-page")
          .getByRole("button", { name: "Pair mobile device" })
          .click();
        await page.getByRole("dialog", { name: "OpenClaw mobile" }).waitFor();
        await page.getByText("How should this phone reach the Gateway?").waitFor();

        await page.getByRole("button", { name: /^Tailscale/ }).click();
        await page.getByText(TAILSCALE_UNAVAILABLE_COPY).waitFor();
        expect((await gateway.getRequests("device.pair.connectivity.plan")).at(-1)?.params).toEqual(
          {
            mode: "tailscale",
          },
        );
        // The unavailable branch states the requirement and offers recovery and
        // nothing else: no link, download, or install action of any kind.
        const branch = page.locator(".device-pair-setup__body");
        expect(await branch.locator("a").count()).toBe(0);
        expect(await branch.locator("button").allInnerTexts()).toEqual(["Retry", "Back"]);
        expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        await settleDialog(page);
        await page.screenshot({ path: path.join(artifactDir, "07-tailscale-unavailable.png") });

        // Back leaves the sibling routes exactly as they were.
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.getByText("How should this phone reach the Gateway?").waitFor();
        expect(await page.getByRole("button", { name: /^Local network/ }).isEnabled()).toBe(true);
        expect(await page.getByRole("button", { name: /^Public address/ }).isEnabled()).toBe(true);

        // Retry re-plans from authoritative Gateway state after the host step.
        await page.getByRole("button", { name: /^Tailscale/ }).click();
        await page.getByText(TAILSCALE_UNAVAILABLE_COPY).waitFor();
        await gateway.setMethodResponse("device.pair.connectivity.plan", tailscalePlan);
        await page.getByRole("button", { name: "Retry" }).click();

        const qr = page.getByAltText("OpenClaw mobile pairing QR code");
        await qr.waitFor();
        // The tailnet candidate answered the challenge in this browser first.
        expect(await gateway.getSocketUrls()).toContain(TAILNET_URL);
        expect((await gateway.getRequests("device.pair.setupCode")).map((r) => r.params)).toEqual([
          { mode: "tailscale" },
        ]);
        expect(await page.getByText(TAILNET_URL, { exact: true }).isVisible()).toBe(true);
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        await settleDialog(page);
        await page.screenshot({ path: path.join(artifactDir, "08-tailscale-code.png") });
        expect(pageErrors).toEqual([]);
      },
    );
  });

  it.each(PAIRING_VIEWPORTS)(
    "renders the chooser and LAN review at $name width in both themes",
    async (viewport) => {
      mkdirSync(artifactDir, { recursive: true });
      for (const colorScheme of ["light", "dark"] as const) {
        await suite.withPage(
          {
            colorScheme,
            locale: "en-US",
            // Deterministic captures: no entry fade to race against.
            reducedMotion: "reduce",
            serviceWorkers: "block",
            viewport: { height: viewport.height, width: viewport.width },
          },
          async ({ page }) => {
            const gateway = await installMockGateway(page, {
              presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
              methodResponses: {
                "device.pair.list": { paired: [], pending: [] },
                "device.pair.connectivity.inspect": loopbackInspection,
                "device.pair.connectivity.plan": lanPlan,
                "node.list": { nodes: [] },
              },
            });

            await page.goto(`${suite.server.baseUrl}settings/security`);
            await page
              .locator(".security-page")
              .getByRole("button", { name: "Pair mobile device" })
              .click();
            await page.getByRole("dialog", { name: "OpenClaw mobile" }).waitFor();
            await page.getByText("How should this phone reach the Gateway?").waitFor();
            await settleDialog(page);
            await page.screenshot({
              path: path.join(artifactDir, `chooser-${viewport.name}-${colorScheme}.png`),
            });

            await page.getByRole("button", { name: /^Local network/ }).click();
            await page
              .getByText("Devices on the same local network can reach this Gateway.")
              .waitFor();
            await settleDialog(page);
            await page.screenshot({
              path: path.join(artifactDir, `lan-review-${viewport.name}-${colorScheme}.png`),
            });

            await page.getByRole("button", { name: "Back", exact: true }).click();
            await page.getByText("How should this phone reach the Gateway?").waitFor();
            await gateway.setMethodResponse("device.pair.connectivity.plan", blockedTailscalePlan);
            await page.getByRole("button", { name: /^Tailscale/ }).click();
            await page.getByText(TAILSCALE_UNAVAILABLE_COPY).waitFor();
            await settleDialog(page);
            await page.screenshot({
              path: path.join(
                artifactDir,
                `tailscale-unavailable-${viewport.name}-${colorScheme}.png`,
              ),
            });
          },
        );
      }
    },
  );
});
