// Control UI E2E tests transcript search through the advertised Gateway method.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-transcript-search",
);

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;
let server: ControlUiE2eServer | undefined;

async function captureUiProof(fileName: string) {
  if (!captureProof || !page) {
    return;
  }
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, fileName) });
}

describeControlUiE2e("Control UI session transcript search", () => {
  beforeAll(async () => {
    if (captureProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    server = await startControlUiE2eServer();
  });

  afterEach(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    context = undefined;
    browser = undefined;
    page = undefined;
  });

  afterAll(async () => {
    await server?.close();
  });

  it("searches once on submit, shows provenance, and opens the matching chat", async () => {
    const timestamp = Date.parse("2026-07-12T14:30:00.000Z");
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    context = await browser.newContext({
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
      ...(captureProof
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1440 } } }
        : {}),
    });
    page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.search"],
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "The nebula launch checklist is ready." }],
          timestamp,
        },
      ],
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            {
              displayName: "Launch planning",
              key: "agent:main:launch",
              kind: "direct",
              label: "Launch planning",
              status: "done",
              totalTokens: 1200,
              updatedAt: timestamp,
            },
          ],
          ts: timestamp,
        },
        "sessions.search": {
          results: [
            {
              messageId: "message-launch",
              role: "assistant",
              score: 3.4,
              sessionId: "session-launch",
              sessionKey: "agent:main:launch",
              snippet: "The nebula launch checklist is ready for final review.",
              timestamp,
            },
          ],
        },
      },
      sessionKey: "agent:main:main",
    });

    await page.goto(`${server?.baseUrl ?? ""}sessions`);
    const search = page.getByRole("search", { name: "Search transcripts" });
    const input = search.getByRole("searchbox", { name: "Search session transcripts" });
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await captureUiProof("01-initial.png");

    await input.fill("  nebula launch  ");
    await captureUiProof("02-query.png");
    expect(await gateway.getRequests("sessions.search")).toHaveLength(0);

    await input.press("Enter");
    const result = page.locator(".sessions-transcript-search__result");
    await result.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(1);
    expect((await gateway.getRequests("sessions.search"))[0]?.params).toEqual({
      limit: 25,
      query: "nebula launch",
    });
    await expect.poll(() => result.textContent()).toContain("Launch planning");
    await expect.poll(() => result.textContent()).toContain("Assistant");
    await expect.poll(() => result.textContent()).toContain("nebula launch checklist");
    await captureUiProof("03-results.png");

    await search.getByRole("button", { name: "Clear" }).click();
    await expect.poll(() => input.inputValue()).toBe("");
    await expect.poll(() => result.count()).toBe(0);
    expect(await gateway.getRequests("sessions.search")).toHaveLength(1);

    await input.fill("nebula launch");
    await input.press("Enter");
    await result.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(2);
    await result.click();
    await expect.poll(() => page?.url()).toContain("session=agent%3Amain%3Alaunch");
    await page
      .getByText("The nebula launch checklist is ready.", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await captureUiProof("04-matching-chat.png");
  });

  it("ignores stale results and exposes indexing and request errors", async () => {
    const timestamp = Date.parse("2026-07-12T14:30:00.000Z");
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width: 1200 },
    });
    page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.search"],
      methodResponses: {
        "sessions.list": {
          count: 0,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          path: "",
          sessions: [],
          ts: timestamp,
        },
        "sessions.search": { indexing: true, results: [] },
      },
    });

    await page.goto(`${server?.baseUrl ?? ""}sessions`);
    const search = page.getByRole("search", { name: "Search transcripts" });
    const input = search.getByRole("searchbox", { name: "Search session transcripts" });
    const submit = search.getByRole("button", { name: "Search" });
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill("   ");
    await expect.poll(() => submit.isDisabled()).toBe(true);
    await input.press("Enter");
    expect(await gateway.getRequests("sessions.search")).toHaveLength(0);

    await gateway.deferNext("sessions.search");
    await input.fill("old phrase");
    await expect.poll(() => submit.isEnabled()).toBe(true);
    await input.press("Enter");
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(1);
    await input.fill("new phrase");
    await gateway.resolveDeferred("sessions.search", {
      results: [
        {
          messageId: "message-stale",
          role: "user",
          score: 1,
          sessionId: "session-stale",
          sessionKey: "agent:main:stale",
          snippet: "stale result must stay hidden",
          timestamp,
        },
      ],
    });
    await page.waitForTimeout(50);
    expect(await page.getByText("stale result must stay hidden", { exact: true }).count()).toBe(0);

    await input.press("Enter");
    await page
      .getByText("The transcript index is still updating. Retry to include recent messages.")
      .waitFor({ state: "visible", timeout: 10_000 });
    expect(await page.getByText("No transcript messages match that search.").count()).toBe(0);
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(2);

    await gateway.setMethodResponse("sessions.search", { results: [] });
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(3);
    await page
      .getByText("No transcript messages match that search.", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    expect(
      await page
        .getByText("The transcript index is still updating. Retry to include recent messages.")
        .count(),
    ).toBe(0);

    await gateway.deferNext("sessions.search");
    await submit.click();
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(4);
    await gateway.rejectDeferred("sessions.search", {
      code: "UNAVAILABLE",
      message: "Search service unavailable",
      retryable: true,
    });
    await page
      .getByText(/Transcript search failed:.*Search service unavailable/)
      .waitFor({ state: "visible", timeout: 10_000 });
  });

  it("disables the control when transcript search is not advertised", async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width: 1200 },
    });
    page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          count: 0,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          path: "",
          sessions: [],
          ts: Date.now(),
        },
      },
    });

    await page.goto(`${server?.baseUrl ?? ""}sessions`);
    const search = page.getByRole("search", { name: "Search transcripts" });
    const input = search.getByRole("searchbox", { name: "Search session transcripts" });
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(() => input.isDisabled()).toBe(true);
    await page
      .getByText("Transcript search requires a newer Gateway.", { exact: true })
      .waitFor({ state: "visible" });
    expect(await gateway.getRequests("sessions.search")).toHaveLength(0);
  });
});
