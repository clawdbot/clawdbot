import path from "node:path";
import { expect, type Locator, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
// Control UI E2E tests cover attributed chat identity placement.
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI attributed chat identity",
  startServerBeforeBrowser: true,
});

let proofArtifactDir: string | undefined;
beforeEach(() => {
  const parent = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR?.trim();
  proofArtifactDir = parent
    ? createControlUiE2eArtifactDir("chat-attributed-identity", parent)
    : undefined;
});

async function captureProof(page: Page, name: string) {
  const artifactDir = proofArtifactDir;
  if (!artifactDir) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    path: path.join(artifactDir, name),
  });
}

async function readFooterGeometry(group: Locator) {
  return group.locator(".chat-group-footer").evaluate((footer) => {
    const actions = footer.querySelector<HTMLElement>(".chat-group-footer-actions");
    const identity = footer.querySelector<HTMLElement>(".chat-group-footer__meta");
    const name = footer.querySelector<HTMLElement>(".chat-sender-name");
    if (!actions || !identity || !name) {
      throw new Error("Expected message footer identity and actions");
    }
    const actionsRect = actions.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const identityRect = identity.getBoundingClientRect();
    const nameRect = name.getBoundingClientRect();
    return {
      actions: {
        left: actionsRect.left,
        right: actionsRect.right,
        top: actionsRect.top,
      },
      identity: {
        bottom: identityRect.bottom,
        left: identityRect.left,
        right: identityRect.right,
      },
      footer: { right: footerRect.right },
      name: { left: nameRect.left - footerRect.left, top: nameRect.top - footerRect.top },
    };
  });
}

function expectStableNamePosition(
  actual: { left: number; top: number },
  expected: { left: number; top: number },
) {
  expect(actual.left).toBe(expected.left);
  expect(actual.top).toBeCloseTo(expected.top, 0);
}

suite.define(() => {
  it("uses one avatar placement and keeps shared-thread authors readable", async () => {
    const artifactDir = proofArtifactDir;
    const context = await suite.browser.newContext({
      viewport: { height: 760, width: 1180 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 760, width: 1180 } } }
        : {}),
    });
    const page = await context.newPage();
    const now = Date.now();
    await page.route("**/api/users/*/avatar*", (route) =>
      route.fulfill({ status: 404, body: "No avatar" }),
    );
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.rewind"],
      presenceUsers: [
        {
          self: true,
          id: "profile-riley",
          identity: { type: "profile", id: "profile-riley" },
          name: "Riley",
          email: "riley@example.test",
        },
        {
          id: "profile-colin",
          identity: { type: "profile", id: "profile-colin" },
          name: "Colin",
          email: "colin@example.test",
        },
        {
          id: "profile-alexandria",
          identity: { type: "profile", id: "profile-alexandria" },
          name: "Alexandria Montgomery-Winter",
          email: "alexandria@example.test",
        },
      ],
      historyMessages: [
        {
          role: "assistant",
          content: "The shared thread now keeps every participant easy to identify.",
          timestamp: now - 180_000,
        },
        {
          role: "user",
          content: "Can we keep one clear avatar and show who wrote each message?",
          timestamp: now - 120_000,
          __openclaw: {
            id: "riley-message",
            senderId: "profile-riley",
            senderIdentity: { type: "profile", id: "profile-riley" },
            senderName: "Riley",
            seq: 2,
          },
        },
        {
          role: "assistant",
          content: "Yes — one author marker is enough, with the name kept readable.",
          timestamp: now - 90_000,
        },
        {
          role: "user",
          content: "This is much easier to scan in a team conversation.",
          timestamp: now - 30_000,
          __openclaw: {
            id: "colin-message",
            senderId: "profile-colin",
            senderIdentity: { type: "profile", id: "profile-colin" },
            senderName: "Colin",
            seq: 4,
          },
        },
        {
          role: "assistant",
          content: "Long participant names keep the same stable layout.",
          timestamp: now - 20_000,
        },
        {
          role: "user",
          content: "My longer identity should remain fixed too.",
          timestamp: now - 10_000,
          __openclaw: {
            id: "alexandria-message",
            senderId: "profile-alexandria",
            senderIdentity: { type: "profile", id: "profile-alexandria" },
            senderName: "Alexandria Montgomery-Winter",
            seq: 6,
          },
        },
      ],
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
    await page.getByText("This is much easier to scan in a team conversation.").waitFor();

    const userGroups = page.locator(".chat-group.user");
    await expect(userGroups).toHaveCount(3);
    for (const [index, initials] of ["R", "C", "AM"].entries()) {
      const avatar = userGroups.nth(index).locator(".chat-avatar:visible");
      await expect(avatar).toHaveCount(1);
      await expect(avatar).toHaveText(initials);
    }
    await expect(page.locator(".sidebar-identity-card openclaw-viewer-avatar")).toContainText("R");

    await expect(
      page.locator(".chat-group-footer--persistent-identity .chat-sender-name"),
    ).toHaveText(["Riley", "Colin", "Alexandria Montgomery-Winter"]);
    await expect(page.locator(".chat-author-avatar")).toHaveCount(0);
    const peerGroup = userGroups.nth(1);
    const longNamePeerGroup = userGroups.last();
    const hoverDetails = peerGroup.locator(".chat-group-timestamp");
    await expect(hoverDetails).toHaveCSS("opacity", "0");
    await captureProof(page, "after-default.png");

    const restingPeerGeometry = await readFooterGeometry(peerGroup);
    await peerGroup.hover();
    await expect(hoverDetails).toHaveCSS("opacity", "1");
    await expect(page.locator(".chat-author-avatar")).toHaveCount(0);
    await captureProof(page, "after-hover.png");
    const hoveredPeerGeometry = await readFooterGeometry(peerGroup);
    expectStableNamePosition(hoveredPeerGeometry.name, restingPeerGeometry.name);
    expect(hoveredPeerGeometry.actions.left - hoveredPeerGeometry.identity.right).toBeCloseTo(8, 0);

    await page.mouse.move(0, 0);
    const restingLongNameGeometry = await readFooterGeometry(longNamePeerGroup);
    await longNamePeerGroup.hover();
    const hoveredLongNameGeometry = await readFooterGeometry(longNamePeerGroup);
    expectStableNamePosition(hoveredLongNameGeometry.name, restingLongNameGeometry.name);
    expect(
      hoveredLongNameGeometry.actions.left - hoveredLongNameGeometry.identity.right,
    ).toBeCloseTo(8, 0);

    await page.mouse.move(0, 0);
    const peerReply = peerGroup.getByRole("button", { name: "Reply to message" });
    await peerReply.focus();
    await expect(hoverDetails).toHaveCSS("opacity", "1");
    const focusedPeerGeometry = await readFooterGeometry(peerGroup);
    expectStableNamePosition(focusedPeerGeometry.name, restingPeerGeometry.name);
    expect(focusedPeerGeometry.actions.left - focusedPeerGeometry.identity.right).toBeCloseTo(8, 0);
    await expect(peerReply).toHaveCSS("opacity", "1");

    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await page.mouse.move(0, 0);
    await expect(hoverDetails).toHaveCSS("opacity", "0");
    const restingRtlGeometry = await readFooterGeometry(peerGroup);
    await peerGroup.hover();
    await expect(hoverDetails).toHaveCSS("opacity", "1");
    const hoveredRtlGeometry = await readFooterGeometry(peerGroup);
    expectStableNamePosition(hoveredRtlGeometry.name, restingRtlGeometry.name);
    expect(hoveredRtlGeometry.identity.left - hoveredRtlGeometry.actions.right).toBeCloseTo(8, 0);

    await page.evaluate(() => {
      document.documentElement.dir = "ltr";
    });
    await page.setViewportSize({ height: 760, width: 390 });
    await page.mouse.move(0, 0);
    const restingTouchGeometry = await readFooterGeometry(longNamePeerGroup);
    const restingTouchHeight = (await longNamePeerGroup.boundingBox())?.height;
    await longNamePeerGroup
      .locator(".chat-bubble")
      .dispatchEvent("pointerup", { pointerType: "touch" });
    await expect(longNamePeerGroup).toHaveClass(/\bchat-group--meta-revealed\b/u);
    const revealedTouchGeometry = await readFooterGeometry(longNamePeerGroup);
    const revealedTouchHeight = (await longNamePeerGroup.boundingBox())?.height;
    expectStableNamePosition(revealedTouchGeometry.name, restingTouchGeometry.name);
    expect(revealedTouchGeometry.actions.top).toBeGreaterThanOrEqual(
      revealedTouchGeometry.identity.bottom,
    );
    expect(revealedTouchGeometry.actions.right).toBeCloseTo(revealedTouchGeometry.footer.right, 0);
    await expect(longNamePeerGroup.getByRole("button", { name: "Reply to message" })).toHaveCSS(
      "opacity",
      "1",
    );
    expect(revealedTouchHeight).toBeGreaterThan(restingTouchHeight ?? 0);

    await page.setViewportSize({ height: 760, width: 1180 });
    // Own-message footer: the always-visible name must stay put when hover
    // reveals the timestamp, which slots in to its left (right-aligned row).
    const ownGroup = userGroups.first();
    const ownName = ownGroup.locator(".chat-sender-name");
    const ownBubble = ownGroup.locator(".chat-bubble");
    await page.mouse.move(0, 0);
    await expect(ownGroup.locator(".chat-group-timestamp")).toHaveCSS("opacity", "0");
    const restingNameBox = await ownName.boundingBox();
    const ownBubbleBox = await ownBubble.boundingBox();
    await ownGroup.hover();
    const ownTimestamp = ownGroup.locator(".chat-group-timestamp");
    await expect(ownTimestamp).toHaveCSS("opacity", "1");
    await captureProof(page, "own-group-hover.png");
    const hoveredNameBox = await ownName.boundingBox();
    const timestampBox = await ownTimestamp.boundingBox();
    expect(hoveredNameBox?.x).toBe(restingNameBox?.x);
    expect((restingNameBox?.x ?? 0) + (restingNameBox?.width ?? 0)).toBeCloseTo(
      (ownBubbleBox?.x ?? 0) + (ownBubbleBox?.width ?? 0),
      0,
    );
    expect((timestampBox?.x ?? 0) + (timestampBox?.width ?? 0)).toBeLessThan(
      hoveredNameBox?.x ?? 0,
    );

    const footerOrder = await peerGroup
      .locator(".chat-group-footer")
      .locator("button, .chat-sender-name, .chat-group-timestamp")
      .evaluateAll((elements) =>
        elements.map((element) => {
          if (element.classList.contains("chat-sender-name")) {
            return "name";
          }
          if (element.classList.contains("chat-group-timestamp")) {
            return "time";
          }
          return element.getAttribute("aria-label");
        }),
      );
    expect(footerOrder).toEqual(["name", "time", "Reply to message", "Rewind"]);

    await context.close();
  });

  it("keeps refreshed self attribution through profile qualification and send reconciliation", async () => {
    const context = await suite.browser.newContext({
      viewport: { height: 900, width: 860 },
    });
    const page = await context.newPage();
    const localSenderId = "c3e32452-0467-47e5-aafa-233cd5dae29f";
    const peerSenderId = "315ee057-302f-45b4-829d-2c5db1bfed75";
    const localAvatarUrl = `/api/users/${localSenderId}/avatar?v=7`;
    const localUser = {
      id: localSenderId,
      identity: { type: "profile" as const, id: localSenderId },
      name: "Collin Johnson",
      avatarUrl: localAvatarUrl,
    };
    const peerUser = {
      id: peerSenderId,
      identity: { type: "profile" as const, id: peerSenderId },
      name: "Riley Chen",
    };
    const priorPrompt = "A prior attributed prompt.";
    const peerPrompt = "A peer attributed prompt.";
    const prompt = "A newly sent attributed prompt.";
    await page.route(`**/api/users/${localSenderId}/avatar*`, async (route) => {
      await route.fulfill({
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="purple"/></svg>`,
        contentType: "image/svg+xml",
        status: 200,
      });
    });
    await page.route(`**/api/users/${peerSenderId}/avatar*`, (route) =>
      route.fulfill({ status: 404, body: "No avatar" }),
    );
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          __openclaw: {
            senderId: localSenderId,
            senderIdentity: { type: "profile", id: localSenderId },
            senderName: "Collin Johnson",
          },
          content: [{ text: priorPrompt, type: "text" }],
          role: "user",
          timestamp: Date.now() - 3_000,
        },
        {
          __openclaw: {
            senderId: peerSenderId,
            senderIdentity: { type: "profile", id: peerSenderId },
            senderName: "Riley Chen",
          },
          content: [{ text: peerPrompt, type: "text" }],
          role: "user",
          timestamp: Date.now() - 2_000,
        },
        {
          content: [{ text: "Ready for the next message.", type: "text" }],
          role: "assistant",
          timestamp: Date.now() - 1_000,
        },
      ],
      presenceUsers: [
        {
          self: true,
          id: localSenderId,
          name: "Raw login",
          avatarUrl: localAvatarUrl,
        },
        peerUser,
      ],
    });

    const readUserAvatarLayout = async (message: string) => {
      const bubble = page.locator(".chat-group.user .chat-bubble", { hasText: message });
      await bubble.waitFor();
      return await bubble.evaluate((bubbleElement) => {
        const group = bubbleElement.closest<HTMLElement>(".chat-group.user");
        const avatar = group
          ? [...group.querySelectorAll<HTMLElement>(".chat-avatar")].find(
              (candidate) => getComputedStyle(candidate).display !== "none",
            )
          : null;
        if (!group || !avatar) {
          throw new Error("Expected a visible attributed user avatar");
        }
        const bubbleRect = bubbleElement.getBoundingClientRect();
        const avatarRect = avatar.getBoundingClientRect();
        return {
          avatarLeft: avatarRect.left,
          avatarRight: avatarRect.right,
          bubbleLeft: bubbleRect.left,
          bubbleRight: bubbleRect.right,
          isPeer: group.classList.contains("chat-group--peer"),
        };
      });
    };

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await page.getByText(priorPrompt, { exact: true }).waitFor();
      await captureProof(page, "self-before-qualification.png");
      const connect = await gateway.waitForRequest("connect");
      const { client } = connect.params as { client: { instanceId: string } };
      await gateway.emitGatewayEvent("presence", {
        presence: [
          { instanceId: client.instanceId, user: localUser, ts: Date.now() },
          { instanceId: "peer-tab", user: peerUser, ts: Date.now() },
        ],
      });
      await expect(page.locator(".sidebar-identity-card")).toContainText(localUser.name);
      const before = await readUserAvatarLayout(priorPrompt);
      const peerBefore = await readUserAvatarLayout(peerPrompt);

      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const afterSend = await readUserAvatarLayout(prompt);
      const priorAfterSend = await readUserAvatarLayout(priorPrompt);
      const peerAfterSend = await readUserAvatarLayout(peerPrompt);
      await captureProof(page, "self-after-qualification-send.png");

      const params = sendRequest.params;
      if (!params || typeof params !== "object" || !("idempotencyKey" in params)) {
        throw new Error("Expected chat send idempotency key");
      }
      const runId = params.idempotencyKey;
      if (typeof runId !== "string" || !runId.trim()) {
        throw new Error("Expected non-empty chat send idempotency key");
      }
      await gateway.emitChatFinal({ runId, text: "The attributed send completed." });
      await page
        .locator(".chat-thread .chat-bubble", { hasText: "The attributed send completed." })
        .waitFor();
      const afterFinal = await readUserAvatarLayout(prompt);

      for (const [phase, layout] of [
        ["initial history", before],
        ["optimistic send", afterSend],
        ["prior message after send", priorAfterSend],
        ["final response", afterFinal],
      ] as const) {
        expect(layout.isPeer, phase).toBe(false);
        expect(layout.avatarLeft, phase).toBeGreaterThanOrEqual(layout.bubbleRight + 9);
      }
      for (const [phase, layout] of [
        ["peer initial history", peerBefore],
        ["peer message after send", peerAfterSend],
      ] as const) {
        expect(layout.isPeer, phase).toBe(true);
        expect(layout.avatarRight, phase).toBeLessThanOrEqual(layout.bubbleLeft - 9);
      }
    } finally {
      await context.close();
    }
  });

  it("keeps an attributed failed send in the transcript with one-line retry metadata", async () => {
    const artifactRoot = process.env.OPENCLAW_BUBBLE_DELIVERY_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("bubble-delivery", artifactRoot)
      : undefined;
    const context = await suite.browser.newContext({ viewport: { height: 760, width: 1180 } });
    const page = await context.newPage();
    const sender = {
      self: true,
      id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
      identity: { type: "profile" as const, id: "c3e32452-0467-47e5-aafa-233cd5dae29f" },
      name: "Collin Johnson",
    };
    const prompt = "Keep my identity stable when delivery fails.";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Ready for a delivery check.", type: "text" }],
          role: "assistant",
          timestamp: Date.now() - 1_000,
        },
      ],
      presenceUsers: [sender],
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await page.getByText("Ready for a delivery check.").waitFor();
      await gateway.deferNext("chat.send");
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const firstSend = await gateway.waitForRequest("chat.send");
      const firstRunId = String((firstSend.params as { idempotencyKey?: unknown }).idempotencyKey);

      const group = page.locator(".chat-group.user", { hasText: prompt });
      await group.waitFor();
      await expect(group).toHaveClass(/\bchat-group--sender-tint\b/u);
      const sendingBackground = await group
        .locator(".chat-bubble")
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "delivery-sending.png"),
        });
      }

      await gateway.rejectDeferred("chat.send", {
        code: "INVALID_REQUEST",
        message: "Mock delivery failure.",
      });
      await expect
        .poll(
          async () =>
            (await page.locator(".chat-send-status, .chat-queue__item--failed").count()) > 0,
        )
        .toBe(true);
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "delivery-failed.png"),
        });
      }

      await expect(group).toBeVisible();
      await expect(page.locator(".chat-queue__item--failed")).toHaveCount(0);
      await expect(page.locator(".chat-error")).toHaveCount(0);
      await expect(page.locator(".agent-chat__composer-combobox textarea")).toHaveValue("");
      const status = group.locator(".chat-send-status");
      await expect(status).toHaveText("· Not sent · Retry");
      const footerLineCenters = await group
        .locator(".chat-sender-name, .chat-send-status")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return rect.top + rect.height / 2;
          }),
        );
      expect(footerLineCenters).toHaveLength(2);
      expect(footerLineCenters[0]).toBeCloseTo(footerLineCenters[1] ?? 0, 0);
      expect(
        await group
          .locator(".chat-bubble")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe(sendingBackground);

      await gateway.deferNext("chat.send");
      await group.getByRole("button", { name: "Retry queued message" }).click();
      await expect(group.locator(".chat-send-status")).toHaveCount(0);
      await expect(group).toBeVisible();
      if (artifactDir) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "delivery-retry.png"),
        });
      }
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(2);
      const sends = await gateway.getRequests("chat.send");
      const retryRunId = String(
        (sends[1]?.params as { idempotencyKey?: unknown } | undefined)?.idempotencyKey,
      );
      expect(retryRunId).not.toBe(firstRunId);
      await gateway.resolveDeferred("chat.send", { runId: retryRunId, status: "started" });
    } finally {
      await context.close();
    }
  });

  it("keeps missing local-viewer avatar initials through a live rerender", async () => {
    const artifactDir = proofArtifactDir;
    const context = await suite.browser.newContext({
      viewport: { height: 760, width: 1180 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 760, width: 1180 } } }
        : {}),
    });
    const page = await context.newPage();
    const viewer = {
      id: "dd7c98e2-f51d-4590-b588-fa0682e165b7",
      identity: { type: "profile" as const, id: "dd7c98e2-f51d-4590-b588-fa0682e165b7" },
      name: "Hannah",
      avatarUrl: "/api/users/dd7c98e2-f51d-4590-b588-fa0682e165b7/avatar?v=7",
    };
    const avatarRequests: Array<{ resourceType: string; url: string }> = [];
    await page.route(`**/api/users/${viewer.id}/avatar*`, async (route) => {
      avatarRequests.push({
        resourceType: route.request().resourceType(),
        url: route.request().url(),
      });
      await route.fulfill({
        body: JSON.stringify({ ok: false, error: { type: "not_found" } }),
        contentType: "application/json",
        status: 404,
      });
    });
    await installMockGateway(page, {
      presenceUsers: [
        {
          self: true,
          ...viewer,
          email: "hannah@example.test",
          watchedSessions: ["agent:main:main"],
        },
      ],
      historyMessages: [
        {
          role: "user",
          content: "Please keep my fallback avatar readable.",
          timestamp: Date.now() - 60_000,
          __openclaw: {
            senderId: viewer.id,
            senderIdentity: viewer.identity,
            senderName: viewer.name,
            senderProfileAvatarUrl: viewer.avatarUrl,
          },
        },
      ],
    });

    try {
      const avatarResponse = page.waitForResponse((response) =>
        response.url().endsWith(viewer.avatarUrl),
      );
      const [response] = await Promise.all([
        avatarResponse,
        page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main")),
      ]);
      expect(response.status()).toBe(404);
      expect(await response.finished()).toBeNull();
      await page.getByText("Please keep my fallback avatar readable.").waitFor();

      const userGroup = page.locator(".chat-group.user", {
        hasText: "Please keep my fallback avatar readable.",
      });
      const slot = userGroup.locator(".chat-avatar-slot");
      const image = slot.locator("img.chat-avatar.user");
      const initials = slot.locator(".chat-avatar--sender-initials");
      expect(avatarRequests).toHaveLength(1);
      expect(
        avatarRequests.map((request) => ({
          resourceType: request.resourceType,
          url: new URL(request.url).pathname + new URL(request.url).search,
        })),
      ).toEqual([{ resourceType: "fetch", url: viewer.avatarUrl }]);
      await expect(slot).toHaveClass(/\bis-fallback\b/u);
      await expect(slot.locator("img.chat-avatar.user[src]")).toHaveCount(0);
      await expect(initials).toBeVisible();
      await expect(initials).toHaveText("H");
      await captureProof(page, "missing-local-avatar-after-404.png");

      await userGroup.hover();
      await userGroup.getByRole("button", { name: "Reply to message" }).click();
      const replyPreview = page.locator(".chat-reply-preview");
      await replyPreview.waitFor({ state: "visible" });
      await expect(replyPreview.locator(".chat-reply-preview__text")).toHaveText(
        "Please keep my fallback avatar readable.",
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );

      expect(avatarRequests).toHaveLength(1);
      await expect(slot).toHaveClass(/\bis-fallback\b/u);
      await expect(slot.locator("img.chat-avatar.user[src]")).toHaveCount(0);
      await expect(initials).toBeVisible();
      await expect(initials).toHaveText("H");
      await captureProof(page, "missing-local-avatar-after-rerender.png");

      await expect.poll(() => image.getAttribute("src")).toBeNull();
    } finally {
      await context.close();
    }
  });
});
