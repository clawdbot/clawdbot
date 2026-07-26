// Control UI E2E tests cover suggestion queue and solo-dormancy behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect, type Browser, type Page } from "playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
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
const sessionKey = "agent:main:main";

let browser: Browser;
let server: ControlUiE2eServer;

function artifactDir(): string | undefined {
  return process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim() || undefined;
}

async function contextAndPage() {
  const output = artifactDir();
  if (output) {
    await fs.mkdir(output, { recursive: true });
  }
  const context = await browser.newContext({
    viewport: { height: 760, width: 1180 },
    ...(output ? { recordVideo: { dir: output, size: { height: 760, width: 1180 } } } : {}),
  });
  return { context, page: await context.newPage() };
}

async function screenshot(page: Page, name: string) {
  const output = artifactDir();
  if (output) {
    await page.screenshot({ animations: "disabled", path: path.join(output, name) });
  }
}

function sessionRow(sharingRole: "owner" | "viewer") {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        key: sessionKey,
        kind: "direct",
        label: "Main",
        sessionId: "session-main",
        status: "done",
        updatedAt: 1,
        visibility: "suggest",
        sharingRole,
      },
    ],
    ts: 1,
  };
}

const featureMethods = [
  "chat.metadata",
  "chat.startup",
  "session.suggestions.add",
  "session.suggestions.list",
  "session.suggestions.resolve",
  "session.typing",
];

describeControlUiE2e("Control UI session suggestions", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("submits a viewer draft as a suggestion and shows its pending state", async () => {
    const { context, page } = await contextAndPage();
    const suggestion = {
      id: "suggestion-1",
      sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "Try the focused change",
      createdAt: 1,
      state: "pending",
    };
    const gateway = await installMockGateway(page, {
      featureMethods,
      presenceUsers: [
        {
          self: true,
          id: "alice",
          name: "Alice",
          watchedSessions: ["main", sessionKey],
        },
        { id: "owner", name: "Owner", watchedSessions: ["main", sessionKey] },
      ],
      methodResponses: {
        "sessions.list": sessionRow("viewer"),
        "session.suggestions.list": { suggestions: [], role: "viewer" },
        "session.suggestions.add": { suggestion },
        "session.typing": { ok: true, broadcast: true },
      },
    });

    await page.goto(`${server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await gateway.waitForRequest("session.suggestions.list");
    await expect(composer).toBeEnabled();
    await gateway.emitGatewayEvent("session.typing", {
      sessionKey: "main",
      sessionId: "session-main",
      agentId: "main",
      actor: { type: "human", id: "owner", label: "Owner" },
      typing: true,
      ts: Date.now(),
    });
    await expect(page.locator(".agent-chat__typing-indicator")).toHaveText("Owner is typing…");
    await composer.fill("Try the focused change");
    const typing = await gateway.waitForRequest("session.typing");
    expect(typing.params).toMatchObject({ sessionId: "session-main" });
    await page.getByRole("button", { name: "Suggest message" }).click();
    const add = await gateway.waitForRequest("session.suggestions.add");
    expect(add.params).toMatchObject({ sessionKey: "main", text: "Try the focused change" });
    await expect(page.locator(".session-suggestion__state")).toHaveText("Pending");
    await expect(page.locator(".session-suggestion__text")).toHaveText("Try the focused change");
    await screenshot(page, "viewer-pending.png");
    await context.close();
  });

  it("shows four owner actions and loads edit into the composer", async () => {
    const { context, page } = await contextAndPage();
    const suggestion = {
      id: "suggestion-2",
      sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "Please edit this first",
      createdAt: 2,
      state: "pending",
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["session.suggestions.resolve"],
      featureMethods,
      presenceUsers: [
        { self: true, id: "owner", name: "Owner", watchedSessions: ["main", sessionKey] },
        { id: "alice", name: "Alice", watchedSessions: ["main", sessionKey] },
      ],
      methodResponses: {
        "sessions.list": sessionRow("owner"),
        "session.suggestions.list": { suggestions: [suggestion], role: "owner" },
      },
    });

    await page.goto(`${server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
    const row = page.locator(".session-suggestion");
    await expect(row).toBeVisible();
    await expect(row.locator("button")).toHaveCount(4);
    expect(
      await row
        .locator("button")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ).toEqual([
      "Send Alice's suggestion now",
      "Queue Alice's suggestion",
      "Edit Alice's suggestion",
      "Dismiss Alice's suggestion",
    ]);
    await page.getByRole("button", { name: "Edit Alice's suggestion" }).click();
    await gateway.waitForRequest("session.suggestions.resolve");
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await expect(composer).toHaveValue("Please edit this first");
    await composer.fill("A newer owner draft");
    await gateway.resolveDeferred("session.suggestions.resolve", {
      suggestion: { ...suggestion, state: "accepted" },
    });
    await expect(composer).toHaveValue("A newer owner draft");
    await screenshot(page, "owner-edit.png");
    await context.close();
  });

  it("keeps suggestion and typing UI dormant with one identity", async () => {
    const { context, page } = await contextAndPage();
    const gateway = await installMockGateway(page, {
      featureMethods,
      presenceUsers: [
        {
          self: true,
          id: "alice",
          name: "Alice",
          watchedSessions: ["main", sessionKey],
        },
      ],
      methodResponses: { "sessions.list": sessionRow("viewer") },
    });

    await page.goto(`${server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
    await expect(page.locator(".agent-chat__composer-combobox textarea")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Suggest message" })).toHaveCount(0);
    await expect(page.locator(".agent-chat__typing-indicator")).toHaveCount(0);
    expect(await gateway.getRequests("session.suggestions.list")).toEqual([]);
    await screenshot(page, "solo-dormant.png");
    await context.close();
  });

  it("keeps older gateways read-only when suggestion RPCs are not advertised", async () => {
    const { context, page } = await contextAndPage();
    await installMockGateway(page, {
      presenceUsers: [
        { self: true, id: "alice", name: "Alice", watchedSessions: ["main"] },
        { id: "owner", name: "Owner", watchedSessions: ["main"] },
      ],
      methodResponses: { "sessions.list": sessionRow("viewer") },
    });

    await page.goto(`${server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`);
    await expect(page.locator(".agent-chat__composer-combobox textarea")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Suggest message" })).toHaveCount(0);
    await context.close();
  });
});
