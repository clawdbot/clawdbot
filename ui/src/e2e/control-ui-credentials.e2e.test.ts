// Control UI tests cover browser credential submission and visible recovery.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(
  process.cwd(),
  process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim() ||
    ".artifacts/control-ui-e2e/control-ui-credentials",
);
const viewport = { height: 900, width: 1280 };

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();

const requireRecord = createRequireRecord("record", "expected-object-value");

function readConnectAuth(request: MockGatewayRequest): Record<string, unknown> | undefined {
  const auth = requireRecord(request.params).auth;
  return auth == null ? undefined : requireRecord(auth);
}

async function createCredentialPage(): Promise<{
  context: BrowserContext;
  gateway: MockGatewayControls;
  page: Page;
}> {
  await mkdir(artifactDir, { recursive: true });
  const context = await browser.newContext({
    locale: "en-US",
    recordVideo: { dir: artifactDir, size: viewport },
    serviceWorkers: "block",
    viewport,
  });
  openContexts.add(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
  const response = await page.goto(server.baseUrl);
  expect(response?.status()).toBe(200);
  return { context, gateway, page };
}

async function waitForNextConnect(
  gateway: MockGatewayControls,
  previousCount: number,
): Promise<MockGatewayRequest> {
  await expect
    .poll(async () => (await gateway.getRequests("connect")).length)
    .toBe(previousCount + 1);
  const request = (await gateway.getRequests("connect")).at(-1);
  if (!request) {
    throw new Error("Expected a new Control UI connect request");
  }
  return request;
}

async function rejectInitialConnect(
  page: Page,
  gateway: MockGatewayControls,
  code: string,
  message: string,
): Promise<void> {
  const initialConnect = await gateway.waitForRequest("connect");
  expect(readConnectAuth(initialConnect)).toBeUndefined();
  await gateway.rejectDeferred("connect", {
    code: "UNAUTHORIZED",
    details: { code },
    message,
  });
  await page.locator("openclaw-login-gate").waitFor();
}

describeControlUiE2e("Control UI token and password credentials E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    await browser?.close();
    await server?.close();
  });

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
  });

  it("submits token and password credentials with visible acceptance and rejection recovery", async () => {
    const tokenFlow = await createCredentialPage();
    const tokenPageErrors: string[] = [];
    tokenFlow.page.on("pageerror", (error) => tokenPageErrors.push(String(error)));
    await rejectInitialConnect(
      tokenFlow.page,
      tokenFlow.gateway,
      ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
      "unauthorized: gateway token required",
    );

    const tokenInput = tokenFlow.page.getByLabel(/Gateway token/i);
    const tokenConnectCount = (await tokenFlow.gateway.getRequests("connect")).length;
    await tokenFlow.gateway.deferNext("connect");
    await tokenInput.fill("token-accepted-by-mock");
    await tokenFlow.page.getByRole("button", { name: "Connect", exact: true }).click();

    const tokenConnect = await waitForNextConnect(tokenFlow.gateway, tokenConnectCount);
    expect(readConnectAuth(tokenConnect)).toMatchObject({
      token: "token-accepted-by-mock",
    });
    expect(readConnectAuth(tokenConnect)?.password).toBeUndefined();
    await tokenFlow.gateway.resolveDeferred("connect");
    await tokenFlow.page.locator("openclaw-app-shell").waitFor();
    expect(await tokenFlow.page.locator("openclaw-login-gate").count()).toBe(0);
    await tokenFlow.page.screenshot({
      fullPage: true,
      path: path.join(artifactDir, "01-token-connected.png"),
    });
    expect(tokenPageErrors).toEqual([]);
    await tokenFlow.context.close();
    openContexts.delete(tokenFlow.context);

    const passwordFlow = await createCredentialPage();
    const passwordPageErrors: string[] = [];
    passwordFlow.page.on("pageerror", (error) => passwordPageErrors.push(String(error)));
    await rejectInitialConnect(
      passwordFlow.page,
      passwordFlow.gateway,
      ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
      "unauthorized: gateway password required",
    );

    const passwordInput = passwordFlow.page.getByLabel(/Password \(not stored\)/i);
    const rejectedConnectCount = (await passwordFlow.gateway.getRequests("connect")).length;
    await passwordFlow.gateway.deferNext("connect");
    await passwordInput.fill("password-rejected-by-mock");
    await passwordFlow.page.getByRole("button", { name: "Connect", exact: true }).click();

    const rejectedConnect = await waitForNextConnect(passwordFlow.gateway, rejectedConnectCount);
    expect(readConnectAuth(rejectedConnect)).toMatchObject({
      password: "password-rejected-by-mock",
    });
    expect(readConnectAuth(rejectedConnect)?.token).toBeUndefined();
    await passwordFlow.gateway.rejectDeferred("connect", {
      code: "UNAUTHORIZED",
      details: { code: ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH },
      message: "unauthorized: gateway password mismatch",
    });

    const failure = passwordFlow.page.locator(".login-gate__failure");
    await failure.waitFor();
    expect(await failure.getAttribute("role")).toBe("alert");
    expect(
      (await failure.locator(".login-gate__failure-raw").textContent())?.toLowerCase(),
    ).toContain("gateway password mismatch");
    expect(await failure.locator(".login-gate__failure-steps").isVisible()).toBe(true);
    expect(await passwordFlow.page.locator("openclaw-app-shell").count()).toBe(0);
    await passwordFlow.page.screenshot({
      fullPage: true,
      path: path.join(artifactDir, "02-password-rejected.png"),
    });

    const recoveredConnectCount = (await passwordFlow.gateway.getRequests("connect")).length;
    await passwordFlow.gateway.deferNext("connect");
    await passwordInput.fill("password-accepted-by-mock");
    await passwordFlow.page.getByRole("button", { name: "Connect", exact: true }).click();

    const recoveredConnect = await waitForNextConnect(passwordFlow.gateway, recoveredConnectCount);
    expect(readConnectAuth(recoveredConnect)).toMatchObject({
      password: "password-accepted-by-mock",
    });
    expect(readConnectAuth(recoveredConnect)?.token).toBeUndefined();
    await passwordFlow.gateway.resolveDeferred("connect");
    await passwordFlow.page.locator("openclaw-app-shell").waitFor();
    expect(await passwordFlow.page.locator("openclaw-login-gate").count()).toBe(0);
    await passwordFlow.page.screenshot({
      fullPage: true,
      path: path.join(artifactDir, "03-password-recovered.png"),
    });
    expect(passwordPageErrors).toEqual([]);

    await writeFile(
      path.join(artifactDir, "behavior-summary.json"),
      `${JSON.stringify(
        {
          password: {
            rejectedOutcome: "visible-error",
            recoveredOutcome: "connected",
            submittedInConnectFrame: true,
          },
          token: {
            acceptedOutcome: "connected",
            submittedInConnectFrame: true,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });
});
