// Control UI E2E tests cover suggestion queue and solo-dormancy behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session suggestions",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:main";

function artifactDir(): string | undefined {
  return process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim() || undefined;
}

async function contextAndPage() {
  const output = artifactDir();
  if (output) {
    await fs.mkdir(output, { recursive: true });
  }
  const context = await suite.browser.newContext({
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
  "commands.list",
  "session.suggestions.add",
  "session.suggestions.list",
  "session.suggestions.resolve",
  "session.typing",
];

suite.define(() => {
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

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    const modelTrigger = page.locator(".chat-controls__model-trigger");
    const typingRow = page.locator('[data-virtual-row-key="presence:typing"]');
    const typingIndicator = typingRow.locator(".agent-chat__typing-indicator");
    await gateway.waitForRequest("session.suggestions.list");
    await expect(composer).toBeEnabled();
    await modelTrigger.waitFor();
    const idleModelBox = await modelTrigger.boundingBox();
    if (idleModelBox === null) {
      throw new Error("Expected the model trigger before remote typing");
    }
    await expect(typingIndicator).toHaveCount(0);
    await gateway.emitGatewayEvent("session.typing", {
      sessionKey: "main",
      sessionId: "session-main",
      agentId: "main",
      actor: { type: "human", id: "owner", label: "Owner" },
      typing: true,
      ts: Date.now(),
    });
    await expect(typingIndicator.locator(".sr-only")).toHaveText("Owner is typing…");
    const [typingModelBox, typingRowBox, composerShellBox] = await Promise.all([
      modelTrigger.boundingBox(),
      typingRow.boundingBox(),
      page.locator(".agent-chat__composer-shell").boundingBox(),
    ]);
    if (typingModelBox === null || typingRowBox === null || composerShellBox === null) {
      throw new Error("Expected the transcript typing row and stable composer layout");
    }
    expect(Math.abs(typingModelBox.x - idleModelBox.x)).toBeLessThanOrEqual(0.5);
    // The #122809 regression shifted the picker by a full indicator row
    // (~20px); allow subpixel/rounding jitter seen on CI renderers (2.41px).
    expect(Math.abs(typingModelBox.y - idleModelBox.y)).toBeLessThanOrEqual(4);
    expect(typingRowBox.y + typingRowBox.height).toBeLessThanOrEqual(composerShellBox.y + 1);
    await gateway.emitGatewayEvent("session.message", {
      sessionKey: "main",
      agentId: "main",
      message: {
        role: "user",
        content: "Owner finished typing",
        __openclaw: { senderId: "owner", senderName: "Owner" },
      },
    });
    await expect(typingIndicator).toHaveCount(0);
    await composer.fill("Try the focused change");
    const typing = await gateway.waitForRequest("session.typing");
    expect(typing.params).toMatchObject({
      sessionId: "session-main",
      preview: "Try the focused change",
    });
    await page.getByRole("button", { name: "Suggest message" }).click();
    const add = await gateway.waitForRequest("session.suggestions.add");
    expect(add.params).toMatchObject({ sessionKey: "main", text: "Try the focused change" });
    await expect(page.locator(".session-suggestion__state")).toHaveText("Pending");
    await expect(page.locator(".session-suggestion__text")).toHaveText("Try the focused change");
    await screenshot(page, "viewer-pending.png");
    await context.close();
  });

  it("does not offer live-session commands in a viewer suggestion composer", async () => {
    const { context, page } = await contextAndPage();
    const gateway = await installMockGateway(page, {
      featureMethods,
      presenceUsers: [
        { self: true, id: "alice", name: "Alice", watchedSessions: ["main", sessionKey] },
        { id: "owner", name: "Owner", watchedSessions: ["main", sessionKey] },
      ],
      methodResponses: {
        "commands.list": {
          commands: [
            {
              acceptsArgs: false,
              description: "Show gateway status.",
              name: "status",
              scope: "both",
              source: "native",
              textAliases: ["/status"],
            },
          ],
        },
        "sessions.list": sessionRow("viewer"),
        "session.suggestions.list": { suggestions: [], role: "viewer" },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await gateway.waitForRequest("session.suggestions.list");
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await expect(composer).toBeEnabled();
    await composer.fill("Keep this /sta");
    await gateway.waitForRequest("commands.list");
    await expect(page.getByRole("option", { name: /\/status/u })).toHaveCount(0);
    await context.close();
  });

  it("streams a remote draft into a live preview bubble", async () => {
    const { context, page } = await contextAndPage();
    const gateway = await installMockGateway(page, {
      featureMethods,
      presenceUsers: [
        { self: true, id: "alice", name: "Alice", watchedSessions: ["main", sessionKey] },
        { id: "owner", name: "Owner", watchedSessions: ["main", sessionKey] },
        { id: "zoe", name: "Zoe", watchedSessions: ["main", sessionKey] },
      ],
      methodResponses: {
        "sessions.list": sessionRow("viewer"),
        "session.suggestions.list": { suggestions: [], role: "viewer" },
        "session.typing": { ok: true, broadcast: true },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const typingRow = page.locator('[data-virtual-row-key="presence:typing"]');
    const previewBubble = typingRow.locator(".agent-chat__typing-preview-bubble");
    await gateway.waitForRequest("session.suggestions.list");
    await expect(page.locator(".agent-chat__composer-combobox textarea")).toBeEnabled();

    const ownerTyping = (preview?: string) =>
      gateway.emitGatewayEvent("session.typing", {
        sessionKey: "main",
        sessionId: "session-main",
        agentId: "main",
        actor: { type: "human", id: "owner", label: "Owner" },
        typing: true,
        ...(preview ? { preview } : {}),
        ts: Date.now(),
      });

    await ownerTyping();
    await expect(typingRow.locator(".agent-chat__typing-bubble > span")).toHaveCount(3);
    await expect(previewBubble).toHaveCount(0);
    await screenshot(page, "typing-dots-before.png");

    const draft = "yea, cool. Live drafts stream into the bubble now.";
    let visible = "";
    for (const word of draft.split(" ")) {
      visible = visible ? `${visible} ${word}` : word;
      await ownerTyping(visible);
      await expect(previewBubble).toHaveText(visible);
      if (artifactDir()) {
        // Readability pacing for the recorded artifact only; assertions above
        // already proved each chunk rendered.
        await page.waitForTimeout(160);
      }
    }
    await expect(typingRow.locator(".agent-chat__typing-preview-label")).toHaveText(
      "Owner is typing…",
    );
    await expect(typingRow.locator(".agent-chat__typing-bubble")).toHaveCount(0);
    await screenshot(page, "typing-preview-live.png");

    await gateway.emitGatewayEvent("session.typing", {
      sessionKey: "main",
      sessionId: "session-main",
      agentId: "main",
      actor: { type: "human", id: "zoe", label: "Zoe" },
      typing: true,
      ts: Date.now(),
    });
    await ownerTyping(draft);
    await expect(typingRow.locator(".agent-chat__typing-bubble > span")).toHaveCount(3);
    await expect(previewBubble).toHaveText(draft);
    const status = typingRow.locator(".sr-only");
    await expect(status).toHaveText("Owner, Zoe are typing…");
    await expect(status).not.toContainText("yea, cool");
    await screenshot(page, "typing-preview-and-dots.png");
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

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
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

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
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

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await expect(page.locator(".agent-chat__composer-combobox textarea")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Suggest message" })).toHaveCount(0);
    await context.close();
  });
});
