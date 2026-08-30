// Real-browser proof + regression for #93041: provider usage from models.authStatus remains
// available in the desktop composer's context popover. Screenshots go to the ignored artifacts tree.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiE2eWaitTimeoutMs,
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI #93041 desktop chat quota popover (mocked Gateway E2E)",
});

const baseTime = 1_700_000_000_000;
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-quota-pill-93041");
const captureOwnershipProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const ownershipProofPhase = process.env.OPENCLAW_UI_PROOF_PHASE?.trim() || "candidate";
const ownershipProofDir = path.resolve(
  process.cwd(),
  ".artifacts/ui-visual-proof/agent-quota-ownership",
  ownershipProofPhase,
);

const authStatusWithUsage = {
  ts: baseTime,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      status: "ok",
      profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
      usage: {
        providerId: "openai",
        windows: [{ label: "Week", usedPercent: 71, resetAt: Date.now() + 4 * 86_400_000 }],
      },
    },
    {
      provider: "github-copilot",
      displayName: "Copilot",
      status: "ok",
      profiles: [{ profileId: "github-copilot", type: "token", status: "ok" }],
      usage: {
        providerId: "github-copilot",
        windows: [{ label: "Day", usedPercent: 41 }],
      },
    },
  ],
};

const gatewayInjectedSessions = {
  count: 1,
  defaults: { contextTokens: 200_000, model: "gateway-injected", modelProvider: "openai" },
  path: "",
  sessions: [
    {
      contextTokens: 200_000,
      displayName: "Main",
      hasActiveRun: false,
      key: "main",
      kind: "direct",
      label: "Main",
      model: "gateway-injected",
      modelProvider: "openai",
      status: "done",
      totalTokens: 46_000,
      totalTokensFresh: true,
      updatedAt: Date.now(),
    },
  ],
  ts: Date.now(),
};

const highPressureSessions = {
  ...gatewayInjectedSessions,
  sessions: [{ ...gatewayInjectedSessions.sessions[0], totalTokens: 190_000 }],
};

const agentsList = {
  agents: [
    { id: "main", name: "Main" },
    { id: "work", name: "Work" },
  ],
  defaultId: "main",
  mainKey: "main",
  scope: "global",
};

function agentAuthStatus(agentId: "main" | "work") {
  const isMain = agentId === "main";
  return {
    ts: baseTime + (isMain ? 1 : 2),
    providers: [
      {
        provider: "openai",
        displayName: isMain ? "Main OpenAI" : "Work OpenAI",
        status: "ok",
        profiles: [{ profileId: `${agentId}-codex`, type: "oauth", status: "ok" }],
        usage: {
          providerId: "openai",
          plan: isMain ? "Main Pro" : "Work Team",
          accountEmail: `${agentId}@example.test`,
          windows: [
            {
              label: "Week",
              usedPercent: isMain ? 81 : 24,
              resetAt: Date.now() + 4 * 86_400_000,
            },
          ],
        },
      },
    ],
  };
}

const selectedGlobalSessions = {
  ...gatewayInjectedSessions,
  sessions: [
    {
      ...gatewayInjectedSessions.sessions[0],
      displayName: "Selected global",
      key: "global",
      kind: "global",
      label: "Selected global",
      modelProvider: "openai",
    },
  ],
};

const claudeSubscriptionAuthStatus = {
  ts: baseTime,
  providers: [
    {
      provider: "claude-cli",
      displayName: "Claude",
      status: "ok",
      profiles: [{ profileId: "claude-cli", type: "oauth", status: "ok" }],
      usage: {
        providerId: "anthropic",
        plan: "Max (20x)",
        windows: [
          { label: "5h", usedPercent: 22, resetAt: Date.now() + 4 * 3_600_000 + 48 * 60_000 },
          { label: "Week", usedPercent: 25, resetAt: Date.now() + 2 * 86_400_000 },
          { label: "Fable", usedPercent: 45 },
        ],
        billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
      },
    },
  ],
};

const claudeSubscriptionSessions = {
  count: 1,
  defaults: {
    contextTokens: 1_000_000,
    model: "claude-fable-5",
    modelProvider: "anthropic",
  },
  path: "",
  sessions: [
    {
      contextTokens: 1_000_000,
      displayName: "Main",
      estimatedCostUsd: 0.02,
      hasActiveRun: false,
      inputTokens: 2_400,
      key: "main",
      kind: "direct",
      label: "Main",
      model: "claude-fable-5",
      // sessions.list canonicalizes CLI aliases; plan matching goes through
      // the auth row's usage.providerId.
      modelProvider: "anthropic",
      outputTokens: 830,
      status: "done",
      totalTokens: 78_700,
      totalTokensFresh: true,
      updatedAt: Date.now(),
    },
  ],
  ts: Date.now(),
};

async function openChat(
  authStatus: unknown,
  extraMethodResponses: Record<string, unknown> = {},
  deferredMethods: string[] = [],
): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    const gateway = await installMockGateway(page, {
      deferredMethods,
      methodResponses: { "models.authStatus": authStatus, ...extraMethodResponses },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("models.authStatus");
    return { context, page };
  } catch (error) {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    throw error;
  }
}

async function closeChat(fixture: { context: BrowserContext; page: Page }): Promise<void> {
  await fixture.page.close().catch(() => {});
  await fixture.context.close().catch(() => {});
}

async function setSelectedAgent(page: Page, name: string): Promise<void> {
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.getByRole("button", { name: /Switch agent/ }).click();
  await sidebar.getByRole("menuitemradio", { name, exact: true }).click();
}

async function replyToAgentMetadata(gateway: MockGatewayControls, agentId: "main" | "work") {
  for (const method of ["models.authStatus", "agent.identity.get"]) {
    const requests = (await gateway.getRequests(method)).filter((request) => {
      const params = request.params;
      return (
        typeof params === "object" &&
        params !== null &&
        "agentId" in params &&
        params.agentId === agentId
      );
    });
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      await gateway.deliverLatest({
        type: "res",
        id: request.id,
        ok: true,
        payload:
          method === "models.authStatus"
            ? agentAuthStatus(agentId)
            : { agentId, name: `${agentId === "main" ? "Stale Main" : "Work"} Agent` },
      });
    }
  }
}

async function visibleAuthState(page: Page) {
  return await page.evaluate(() => {
    const pane = document.querySelector("openclaw-chat-pane.chat-pane-cache__pane--visible") as
      | (HTMLElement & {
          state?: {
            assistantAgentId?: string | null;
            modelAuthStatusError?: string | null;
            modelAuthStatusResult?: {
              ts?: number;
              providers?: Array<{
                displayName?: string;
                usage?: { accountEmail?: string; plan?: string };
              }>;
            } | null;
          };
        })
      | null;
    const provider = pane?.state?.modelAuthStatusResult?.providers?.[0];
    return {
      account: provider?.usage?.accountEmail ?? null,
      agentId: pane?.state?.assistantAgentId ?? null,
      displayName: provider?.displayName ?? null,
      error: pane?.state?.modelAuthStatusError ?? null,
      plan: provider?.usage?.plan ?? null,
      ts: pane?.state?.modelAuthStatusResult?.ts ?? null,
    };
  });
}

async function setOwnershipProofCue(page: Page, text: string): Promise<void> {
  await page.evaluate((label) => {
    let cue = document.querySelector<HTMLElement>("[data-auth-ownership-proof-cue]");
    if (!cue) {
      cue = document.createElement("div");
      cue.dataset.authOwnershipProofCue = "true";
      Object.assign(cue.style, {
        background: "#171717",
        border: "1px solid #fafafa",
        borderRadius: "4px",
        color: "#fafafa",
        font: "600 13px/1.4 system-ui, sans-serif",
        maxWidth: "420px",
        padding: "8px 10px",
        position: "fixed",
        right: "16px",
        top: "16px",
        zIndex: "2147483647",
      });
      document.body.append(cue);
    }
    cue.textContent = label;
  }, text);
}

async function pauseForOwnershipProof(page: Page): Promise<void> {
  if (captureOwnershipProof) {
    await page.waitForTimeout(2_200);
  }
}

async function openVisibleQuotaPopover(page: Page) {
  const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
  const popover = visiblePane.locator(".context-usage__popover");
  if (!(await popover.isVisible())) {
    await visiblePane.locator(".context-ring").click();
  }
  await popover.waitFor({ state: "visible" });
  return popover;
}

suite.define(() => {
  it("shows high context pressure without a compact action", async () => {
    const fixture = await openChat(authStatusWithUsage, {
      "sessions.list": highPressureSessions,
    });
    const { page } = fixture;
    try {
      const contextRing = page.locator(".context-ring");
      await contextRing.waitFor({ state: "visible" });
      expect(await contextRing.getAttribute("aria-label")).toBe(
        "Session context usage: 190k of 200k (95%)",
      );
      expect(
        await contextRing.evaluate((element) =>
          element.classList.contains("context-ring--warning"),
        ),
      ).toBe(true);
      expect(await page.locator(".context-usage button").count()).toBe(0);
      await page.screenshot({
        path: path.join(artifactDir, "00-high-context-without-compact-action.png"),
      });
    } finally {
      await closeChat(fixture);
    }
  });

  it("renders provider usage inside the desktop context popover", async () => {
    const fixture = await openChat(authStatusWithUsage, {
      "sessions.list": gatewayInjectedSessions,
    });
    const { page } = fixture;
    try {
      const contextRing = page.locator(".context-ring");
      const usageLinks = page.locator('[data-chat-provider-usage="true"]');
      const usageLink = usageLinks.first();
      await contextRing.waitFor({ state: "visible" });
      expect(await usageLink.isVisible()).toBe(false);
      await contextRing.click();
      await usageLink.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "01-chat-with-context-usage.png") });
      await page.locator(".context-usage__popover").screenshot({
        path: path.join(artifactDir, "02-context-usage-popover.png"),
      });

      expect(await usageLinks.count()).toBe(1);
      expect(await usageLink.getAttribute("href")).toBe("/usage");
      const rows = await page.locator(".context-usage__limit").allTextContents();
      const normalized = rows.map((row) => row.replace(/\s+/g, " ").trim());
      expect(normalized).toHaveLength(1);
      expect(normalized[0]).toMatch(/^Weekly Resets .+ 71%$/);
      expect((await page.locator(".context-usage__popover").textContent()) ?? "").not.toContain(
        "Copilot",
      );
      expect(
        (await page.locator('[data-chat-usage-provider="true"]').textContent())
          ?.replace(/\s+/g, " ")
          .trim(),
      ).toBe("Provider: OpenAI");
      const popoverText = (await page.locator(".context-usage__popover").textContent()) ?? "";
      expect(popoverText).not.toContain("openclaw");
      expect(popoverText).not.toContain("gateway-injected");
      expect(popoverText).not.toContain("Model:");
    } finally {
      await closeChat(fixture);
    }
  });

  it("shows plan bars, credits, and no dollar estimates for subscription sessions", async () => {
    const fixture = await openChat(claudeSubscriptionAuthStatus, {
      "sessions.list": claudeSubscriptionSessions,
    });
    const { page } = fixture;
    try {
      const contextRing = page.locator(".context-ring");
      await contextRing.waitFor({ state: "visible" });
      await contextRing.click();
      await page.locator(".context-usage__popover").waitFor({ state: "visible" });
      await page.locator(".context-usage__popover").screenshot({
        path: path.join(artifactDir, "03-claude-subscription-popover.png"),
      });

      expect(await page.locator(".context-usage__plan-badge").textContent()).toBe("Max (20x)");
      const rows = await page.locator(".context-usage__limit").allTextContents();
      const normalized = rows.map((row) => row.replace(/\s+/g, " ").trim());
      expect(normalized[0]).toMatch(/^5-hour limit Resets .+ 22%$/);
      expect(normalized[1]).toMatch(/^Weekly Resets .+ 25%$/);
      expect(normalized[2]).toBe("Fable 45%");
      expect(normalized[3]).toBe("Usage credits $157.85 of $400.00");

      const popoverText = (await page.locator(".context-usage__popover").textContent()) ?? "";
      expect(popoverText).not.toContain("Est. cost");
      expect(popoverText).not.toContain("Cost by Type");
      expect(popoverText).toContain("Latest run tokens");
    } finally {
      await closeChat(fixture);
    }
  });

  it("shows no plan usage when no provider usage windows are present", async () => {
    const fixture = await openChat(
      { ts: baseTime, providers: [] },
      { "sessions.list": gatewayInjectedSessions },
    );
    const { page } = fixture;
    try {
      const contextRing = page.locator(".context-ring");
      await contextRing.waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const pane = document.querySelector("openclaw-chat-pane") as
          | (HTMLElement & {
              state?: { modelAuthStatusResult?: { providers?: unknown[] } | null };
            })
          | null;
        return Array.isArray(pane?.state?.modelAuthStatusResult?.providers);
      });
      await contextRing.click();
      const popover = page.locator(".context-usage__popover");
      await popover.waitFor({ state: "visible" });
      await popover.screenshot({ path: path.join(artifactDir, "04-usage-unavailable.png") });
      expect(await page.locator('[data-chat-provider-usage="true"]').count()).toBe(0);
      const popoverText = (await popover.textContent()) ?? "";
      expect(popoverText).not.toContain("openclaw");
      expect(popoverText).not.toContain("gateway-injected");
      expect(popoverText).not.toContain("Model:");
    } finally {
      await closeChat(fixture);
    }
  });

  it("binds delayed auth and quota presentation to the selected global agent", async () => {
    if (captureOwnershipProof) {
      await mkdir(ownershipProofDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureOwnershipProof
        ? { recordVideo: { dir: ownershipProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const video = page.video();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    try {
      const gateway = await installMockGateway(page, {
        assistantAgentId: "main",
        defaultAgentId: "main",
        heldMethods: ["models.authStatus", "agent.identity.get"],
        // The selected agent's session metrics may not have arrived; its transcript
        // still identifies which provider's quota belongs in the popover.
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Ready." }],
            provider: "openai",
          },
        ],
        methodResponses: {
          "agent.identity.get": {
            cases: [
              { match: { agentId: "main" }, response: { agentId: "main", name: "Main Agent" } },
              { match: { agentId: "work" }, response: { agentId: "work", name: "Work Agent" } },
            ],
          },
          "agents.list": agentsList,
          "models.authStatus": {
            cases: [
              { match: { agentId: "main" }, response: agentAuthStatus("main") },
              { match: { agentId: "work" }, response: agentAuthStatus("work") },
            ],
          },
          "sessions.list": selectedGlobalSessions,
          // A Work main alias resolves to Work's canonical global history on
          // the Gateway; it must not borrow the Main-owned list projection.
          "chat.startup": {
            cases: [
              {
                match: { sessionKey: "agent:work:main", agentId: "work" },
                response: {
                  messages: [],
                  sessionId: "session:work:global",
                  sessionInfo: {
                    ...selectedGlobalSessions.sessions[0],
                    agentId: "work",
                    sessionId: "session:work:global",
                    contextTokens: 300_000,
                    totalTokens: 90_000,
                  },
                },
              },
            ],
          },
        },
        sessionKey: "global",
        sessionScope: "global",
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "global"));
      const connectRequest = await gateway.waitForRequest("connect");
      const { client: connectedClient } = connectRequest.params as {
        client: { instanceId: string };
      };
      await expect
        .poll(async () => (await gateway.getRequests("models.authStatus")).length)
        .toBe(2);

      expect((await gateway.waitForRequest("chat.startup")).params).toMatchObject({
        sessionKey: "global",
        agentId: "main",
      });
      let popover = await openVisibleQuotaPopover(page);
      expect(
        await page
          .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
          .locator('[data-chat-provider-usage="true"]')
          .count(),
      ).toBe(0);
      await setOwnershipProofCue(page, "Selected agent: Main | Main auth request delayed");
      await pauseForOwnershipProof(page);

      await page.evaluate(() => {
        const pane = document.querySelector("openclaw-chat-pane.chat-pane-cache__pane--visible") as
          | (HTMLElement & {
              state?: {
                assistantName: string;
                assistantAvatar: string | null;
                chatAvatarUrl: string | null;
                requestUpdate?: () => void;
              };
            })
          | null;
        if (pane?.state) {
          pane.state.assistantName = "Main Agent";
          pane.state.assistantAvatar = "M";
          pane.state.chatAvatarUrl = "https://example.test/main-avatar.png";
          pane.state.requestUpdate?.();
        }
      });
      await setSelectedAgent(page, "Work");
      await expect.poll(async () => (await visibleAuthState(page)).agentId).toBe("work");
      await expect
        .poll(async () => (await gateway.getRequests("models.authStatus")).length)
        .toBeGreaterThanOrEqual(3);
      await expect
        .poll(() => visibleAuthState(page))
        .toEqual({
          account: null,
          agentId: "work",
          displayName: null,
          error: null,
          plan: null,
          ts: null,
        });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const pane = document.querySelector(
              "openclaw-chat-pane.chat-pane-cache__pane--visible",
            ) as
              | (HTMLElement & {
                  state?: {
                    assistantName?: string;
                    assistantAvatar?: string | null;
                    chatAvatarUrl?: string | null;
                  };
                })
              | null;
            return {
              name: pane?.state?.assistantName ?? null,
              avatar: pane?.state?.assistantAvatar ?? null,
              renderedAvatar: pane?.state?.chatAvatarUrl ?? null,
            };
          }),
        )
        .toEqual({ name: "OpenClaw", avatar: null, renderedAvatar: null });
      await gateway.emitGatewayEvent("presence", {
        presence: [
          {
            instanceId: connectedClient.instanceId,
            user: { id: "operator", name: "Operator" },
            ts: Date.now(),
          },
        ],
      });
      await expect
        .poll(() => visibleAuthState(page))
        .toEqual({
          account: null,
          agentId: "work",
          displayName: null,
          error: null,
          plan: null,
          ts: null,
        });
      await setOwnershipProofCue(page, "Selected agent: Work | Work auth loading");
      await pauseForOwnershipProof(page);
      if (captureOwnershipProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(ownershipProofDir, "01-work-loading.png"),
        });
      }

      await replyToAgentMetadata(gateway, "main");
      await page.waitForTimeout(100);
      const delayedMainState = await visibleAuthState(page);
      expect(delayedMainState).toEqual({
        account: null,
        agentId: "work",
        displayName: null,
        error: null,
        plan: null,
        ts: null,
      });
      await setOwnershipProofCue(
        page,
        delayedMainState.account === "main@example.test"
          ? `Visible agent: ${delayedMainState.agentId} | Displayed stale account: ${delayedMainState.account} | Plan: ${delayedMainState.plan}`
          : delayedMainState.account
            ? `Visible agent: ${delayedMainState.agentId} | Work result settled | Plan: ${delayedMainState.plan}`
            : `Visible agent: ${delayedMainState.agentId} | Delayed Main ignored | Work auth loading`,
      );
      await pauseForOwnershipProof(page);
      if (captureOwnershipProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(ownershipProofDir, "02-after-delayed-main.png"),
        });
      }

      expect(delayedMainState.agentId).toBe("work");
      expect(delayedMainState.error).toBeNull();
      expect(delayedMainState.account).not.toBe("main@example.test");
      expect(delayedMainState.displayName).not.toBe("Main OpenAI");
      expect(delayedMainState.plan).not.toBe("Main Pro");
      const authRequests = await gateway.getRequests("models.authStatus");
      const workAuthRequests = authRequests.filter(
        (request) =>
          typeof request.params === "object" &&
          request.params !== null &&
          "agentId" in request.params &&
          request.params.agentId === "work",
      );
      expect(workAuthRequests.length).toBeGreaterThanOrEqual(2);
      const identityRequests = await gateway.getRequests("agent.identity.get");
      expect(
        identityRequests.filter(
          (request) =>
            typeof request.params === "object" &&
            request.params !== null &&
            "agentId" in request.params &&
            request.params.agentId === "work",
        ),
      ).not.toHaveLength(0);

      await replyToAgentMetadata(gateway, "work");
      await expect
        .poll(() => visibleAuthState(page))
        .toEqual({
          account: "work@example.test",
          agentId: "work",
          displayName: "Work OpenAI",
          error: null,
          plan: "Work Team",
          ts: baseTime + 2,
        });
      await setOwnershipProofCue(page, "Selected agent: Work | Work account and plan loaded");
      if (captureOwnershipProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(ownershipProofDir, "03-work-settled.png"),
        });
      }
      popover = await openVisibleQuotaPopover(page);
      expect(
        await page
          .locator("openclaw-chat-pane.chat-pane-cache__pane--visible .context-ring")
          .getAttribute("aria-label"),
      ).toBe("Session context usage: 90k of 300k (30%)");
      expect((await gateway.getRequests("chat.startup")).at(-1)?.params).toMatchObject({
        sessionKey: "agent:work:main",
        agentId: "work",
      });
      await expect.poll(async () => popover.textContent()).toContain("Work Team");
      const settledText = (await popover.textContent()) ?? "";
      expect(settledText).toContain("work@example.test");
      expect(settledText).toContain("24%");
      expect(settledText).not.toContain("Main Pro");
      expect(settledText).not.toContain("main@example.test");
      await setOwnershipProofCue(
        page,
        "Selected agent: Work | Account: work@example.test | Plan: Work Team | Quota: 24%",
      );
      await pauseForOwnershipProof(page);
      if (captureOwnershipProof) {
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(ownershipProofDir, "03-work-settled.png"),
        });
      }
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      if (captureOwnershipProof && video) {
        await video
          .saveAs(path.join(ownershipProofDir, `${ownershipProofPhase}.webm`))
          .catch(() => {});
      }
    }
  });
});
