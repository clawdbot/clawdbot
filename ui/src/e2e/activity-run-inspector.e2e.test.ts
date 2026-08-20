import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditRunInspectResult } from "../../../packages/gateway-protocol/src/schema/audit-run.js";
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
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.resolve(".artifacts/control-ui-e2e/activity-run-inspector");
const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;

let browser: Browser;
let server: ControlUiE2eServer;

function presentResult(runId: string, executionId = "execution-safe-ref"): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId, executionId, status: "known" },
    identity: {
      state: "present",
      context: {
        schemaVersion: 1,
        contextId: "context-safe-ref",
        executionId,
        runId,
        createdAt: 1_786_000_000_000,
        trustDomain: { kind: "gateway-cell", domainRef: hmacRef, state: "present" },
        invoker: { state: "absent" },
        ingress: {
          kind: "gateway-client",
          boundary: "agent-command.gateway",
          sourceRef: hmacRef,
          state: "present",
        },
        agentPrincipal: {
          kind: "agent",
          domainRef: hmacRef,
          principalRef: "main",
          displayLabel: "Primary agent",
        },
        agentDefinition: { definitionRef: "main", state: "unknown" },
        runtimeInstance: { runtimeRef: hmacRef, kind: "gateway", state: "unsupported" },
        representedSubject: {
          principal: { kind: "person", domainRef: hmacRef, principalRef: hmacRef },
          state: "unknown",
        },
        sponsor: {
          principal: { kind: "service", domainRef: hmacRef, principalRef: hmacRef },
          state: "unsupported",
        },
        applicableGrants: [{ grantRef: hmacRef, state: "absent" }],
        assurance: [
          { kind: "runtime-binding", evidenceRef: hmacRef, strength: "boundary-verified" },
        ],
        lineage: { parentRunId: "parent-safe-ref", depth: 1 },
        coverageState: "unattributed",
        missingEvidence: ["invoker.principal"],
      },
    },
    decisions: [
      {
        schemaVersion: 1,
        receiptId: "receipt-safe-ref",
        contextId: "context-safe-ref",
        executionId,
        runId,
        occurredAt: 1_786_000_000_000,
        action: {
          family: "run",
          operation: "admission",
          summary: "Run admission was recorded without identity-aware evaluation.",
        },
        decision: {
          outcome: "not-applicable",
          reasonCode: "run_admission_identity_not_evaluated",
        },
        enforcement: {
          coverageState: "unattributed",
          policyRefs: [],
          grantRefs: [],
          contextFieldsUsed: [],
        },
        source: {
          owner: "agent-command",
          recordRef: "context-safe-ref",
          decisionBoundary: "agent-command.run-admission",
        },
        missingEvidence: ["invoker.principal"],
        remediation: [
          {
            code: "no_identity_enforcement_claimed",
            text: "Treat this receipt as attribution only; it does not prove authorization.",
          },
        ],
      },
    ],
    coverage: { state: "unattributed", missingEvidence: ["invoker.principal"] },
    nextDecisionCursor: "1",
  };
}

function unavailableResult(params: {
  state: "unknown" | "unsupported";
  reasonCode: string;
  remediation?: Array<{ code: string; text: string }>;
}): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId: "typed-state", status: params.state === "unknown" ? "unknown" : "known" },
    identity: {
      state: params.state,
      reasonCode: params.reasonCode,
      missingEvidence: ["identity.context"],
      remediation: params.remediation ?? [],
    },
    decisions: [],
    coverage: { state: params.state, missingEvidence: ["identity.context"] },
  };
}

function ambiguousResult(
  runId: string,
  executionId: string,
  nextExecutionCursor?: string,
): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId, status: "known" },
    identity: {
      state: "ambiguous",
      reasonCode: "execution_selection_required",
      candidates: [
        { executionId, contextId: "candidate-context-safe-ref", createdAt: 1_786_000_000_000 },
      ],
      missingEvidence: ["execution.selection"],
      remediation: [
        {
          code: "select_exact_execution",
          text: "Select one exact execution before inspecting identity evidence.",
        },
      ],
    },
    decisions: [],
    coverage: { state: "unknown", missingEvidence: ["execution.selection"] },
    ...(nextExecutionCursor ? { nextExecutionCursor } : {}),
  };
}

async function newContext(options: { video?: boolean } = {}): Promise<BrowserContext> {
  if (captureUiProof) {
    await mkdir(path.join(proofDir, "video"), { recursive: true });
  }
  return browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 1000, width: 1440 },
    ...(captureUiProof && options.video
      ? { recordVideo: { dir: path.join(proofDir, "video"), size: { height: 1000, width: 1440 } } }
      : {}),
  });
}

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

async function measureWithinAncestor(element: Locator, ancestorSelector: string) {
  return element.evaluate((node, selector) => {
    const ancestor = node.closest<HTMLElement>(selector);
    if (!ancestor) {
      throw new Error(`Expected element inside ${selector}`);
    }
    const elementBounds = node.getBoundingClientRect();
    const ancestorBounds = ancestor.getBoundingClientRect();
    return {
      ancestorBottom: ancestorBounds.bottom,
      ancestorTop: ancestorBounds.top,
      elementBottom: elementBounds.bottom,
      elementTop: elementBounds.top,
    };
  }, ancestorSelector);
}

describeControlUiE2e("Control UI durable Activity run inspector", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("deep-links, reloads durable evidence, and exposes text-first accessible states", async () => {
    const context = await newContext({ video: true });
    const page = await context.newPage();
    const runId = "run:durable/one";
    const gateway = await installMockGateway(page, {
      featureMethods: ["audit.run.inspect"],
      methodResponses: { "audit.run.inspect": presentResult(runId) },
    });

    try {
      await page.goto(`${server.baseUrl}activity?view=run&run=${encodeURIComponent(runId)}`);
      await page.getByRole("heading", { name: "Identity and authority" }).waitFor();
      expect(await gateway.waitForRequest("audit.run.inspect")).toMatchObject({
        params: { runId, decisionLimit: 50, executionLimit: 50 },
      });
      expect((await gateway.getRequests("audit.run.inspect")).length).toBe(1);

      expect(await page.getByRole("tab", { name: "Run inspector" }).count()).toBe(0);
      const modePanel = page.locator("#activity-mode-panel");
      expect(await modePanel.getAttribute("role")).toBeNull();
      expect(await modePanel.getAttribute("aria-labelledby")).toBeNull();
      const backToSessions = page.getByRole("link", { name: "Back to sessions" });
      await backToSessions.waitFor();
      expect(await backToSessions.getAttribute("href")).toBe("/activity");
      await page.getByRole("status", { name: "Inspection coverage: Unattributed" }).waitFor();
      for (const state of ["Present", "Absent", "Unknown", "Unsupported"]) {
        await page.locator(`[aria-label="Evidence state: ${state}"]`).first().waitFor();
      }
      for (const dimension of [
        "Trust domain",
        "Ingress",
        "Invoker",
        "Represented subject",
        "Sponsor",
        "Agent principal",
        "Runtime instance",
        "Applicable grant 1",
        "Assurance evidence 1",
        "Lineage",
      ]) {
        await page.getByText(dimension, { exact: true }).waitFor();
      }
      await page.getByText("Best-effort audit warning", { exact: false }).waitFor();
      await page
        .getByText("Additional decision receipts are available", { exact: false })
        .waitFor();
      expect(await page.getByText("receipt-safe-ref", { exact: false }).count()).toBe(0);
      expect(await page.getByText("context-safe-ref", { exact: false }).count()).toBe(0);
      expect(await page.getByText("execution-safe-ref", { exact: false }).count()).toBe(0);
      expect(await page.getByText("raw-sender-id-42", { exact: false }).count()).toBe(0);
      await screenshot(page, "01-present-unattributed.png");

      await page.reload();
      await page.getByRole("heading", { name: "Identity and authority" }).waitFor();
      expect(await gateway.waitForRequest("audit.run.inspect")).toMatchObject({
        params: { runId, decisionLimit: 50, executionLimit: 50 },
      });
      expect((await gateway.getRequests("audit.run.inspect")).length).toBe(1);

      await backToSessions.click();
      await page.getByRole("tab", { name: "Sessions" }).waitFor();
      expect(await page.getByRole("tab").count()).toBe(2);
      expect(await page.getByRole("tab", { name: "Run inspector" }).count()).toBe(0);
      const liveTab = page.getByRole("tab", { name: "Live activity" });
      await liveTab.focus();
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim()))
        .toBe("Live activity");
      await page.keyboard.press("Enter");
      await page.getByText("No activity yet.", { exact: true }).waitFor();
      await expect
        .poll(() => modePanel.getAttribute("aria-labelledby"))
        .toBe("activity-mode-tab-live");
      expect(new URL(page.url()).search).toBe("?view=live");
      await page.goBack();
      await expect
        .poll(() => page.getByRole("tab", { name: "Sessions" }).getAttribute("aria-selected"))
        .toBe("true");
      await page.goBack();
      await page.getByRole("heading", { name: "Identity and authority" }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("keeps a populated Live activity stream bounded after adding the mode switcher", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { sessionKey: "main" });

    try {
      await page.goto(`${server.baseUrl}activity?view=live`);
      await page.getByText("No activity yet.", { exact: true }).waitFor();

      for (let index = 0; index < 40; index += 1) {
        await gateway.emitGatewayEvent("agent", {
          runId: `run-layout-${index}`,
          seq: 1,
          stream: "tool",
          ts: Date.now() + index,
          sessionKey: "main",
          data: {
            phase: "start",
            name: `layout_tool_${index}`,
            toolCallId: `tool-layout-${index}`,
            args: {},
          },
        });
      }

      const stream = page.locator(".activity-stream");
      await expect.poll(() => page.locator(".activity-entry").count()).toBe(40);
      const layout = await page.locator("#activity-mode-panel").evaluate((modePanel) => {
        const livePanel = modePanel.querySelector<HTMLElement>("#activity-live-panel");
        const streamElement = modePanel.querySelector<HTMLElement>(".activity-stream");
        if (!livePanel || !streamElement) {
          throw new Error("Live Activity layout is incomplete");
        }
        const modeStyle = getComputedStyle(modePanel);
        const liveStyle = getComputedStyle(livePanel);
        const workspace = modePanel.closest<HTMLElement>(".settings-workspace--fill-height");
        return {
          documentScrollHeight: document.documentElement.scrollHeight,
          liveDisplay: liveStyle.display,
          liveFlexGrow: liveStyle.flexGrow,
          modeDisplay: modeStyle.display,
          modeFlexGrow: modeStyle.flexGrow,
          streamBottom: streamElement.getBoundingClientRect().bottom,
          streamClientHeight: streamElement.clientHeight,
          streamScrollHeight: streamElement.scrollHeight,
          viewportHeight: window.innerHeight,
          workspaceBottom: workspace?.getBoundingClientRect().bottom ?? 0,
        };
      });
      expect(layout.modeDisplay).toBe("flex");
      expect(layout.modeFlexGrow).toBe("1");
      expect(layout.liveDisplay).toBe("flex");
      expect(layout.liveFlexGrow).toBe("1");
      expect(layout.streamScrollHeight).toBeGreaterThan(layout.streamClientHeight);
      expect(layout.streamBottom).toBeLessThanOrEqual(layout.workspaceBottom + 1);
      expect(layout.documentScrollHeight).toBeLessThanOrEqual(layout.viewportHeight + 1);
      await stream.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event("scroll"));
      });
      await expect
        .poll(() =>
          stream.evaluate(
            (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThanOrEqual(1);
      await screenshot(page, "13-populated-live-activity.png");

      await page.setViewportSize({ height: 900, width: 720 });
      const mobileLayout = await page.locator("main.content").evaluate((content) => {
        const outlet = content.querySelector("openclaw-router-outlet");
        const streamElement = content.querySelector<HTMLElement>(".activity-stream");
        if (!outlet || !streamElement) {
          throw new Error("Mobile Live Activity layout is incomplete");
        }
        return {
          contentClientHeight: content.clientHeight,
          contentOverflowY: getComputedStyle(content).overflowY,
          contentScrollHeight: content.scrollHeight,
          outletDisplay: getComputedStyle(outlet).display,
        };
      });
      expect(mobileLayout.contentOverflowY).toBe("auto");
      expect(mobileLayout.outletDisplay).toBe("block");
      expect(mobileLayout.contentScrollHeight).toBeGreaterThan(mobileLayout.contentClientHeight);
    } finally {
      await context.close();
    }
  });

  it("keeps populated desktop run evidence reachable without taking mobile page scrolling", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const runId = "run:bounded/inspector";
    await page.setViewportSize({ height: 640, width: 900 });
    await installMockGateway(page, {
      featureMethods: ["audit.run.inspect"],
      methodResponses: { "audit.run.inspect": presentResult(runId) },
    });

    try {
      await page.goto(`${server.baseUrl}activity?view=run&run=${encodeURIComponent(runId)}`);
      const inspector = page.locator(".run-inspector");
      const finalReceiptContent = page.getByText("Additional decision receipts are available", {
        exact: false,
      });
      await finalReceiptContent.waitFor({ state: "attached" });

      const desktopLayout = await inspector.evaluate((element) => ({
        clientHeight: element.clientHeight,
        documentScrollHeight: document.documentElement.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
        viewportHeight: window.innerHeight,
      }));
      expect(desktopLayout.overflowY).toBe("auto");
      expect(desktopLayout.scrollHeight).toBeGreaterThan(desktopLayout.clientHeight);
      expect(desktopLayout.documentScrollHeight).toBeLessThanOrEqual(
        desktopLayout.viewportHeight + 1,
      );

      await inspector.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() =>
          inspector.evaluate(
            (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
          ),
        )
        .toBeLessThanOrEqual(1);
      const finalContentPosition = await measureWithinAncestor(
        finalReceiptContent,
        ".run-inspector",
      );
      expect(finalContentPosition.elementTop).toBeGreaterThanOrEqual(
        finalContentPosition.ancestorTop,
      );
      // Bound is 2, not 1: the scroll poll above tolerates a <=1px remainder
      // (scrollHeight/clientHeight are integer-rounded) and the rects here are
      // fractional, so sub-pixel rendering can add up to another pixel.
      expect(finalContentPosition.elementBottom).toBeLessThanOrEqual(
        finalContentPosition.ancestorBottom + 2,
      );
      await screenshot(page, "14-bounded-run-inspector.png");

      await page.setViewportSize({ height: 900, width: 720 });
      const mobileLayout = await page.locator("main.content").evaluate((content) => {
        const inspectorElement = content.querySelector<HTMLElement>(".run-inspector");
        if (!inspectorElement) {
          throw new Error("Mobile run inspector layout is incomplete");
        }
        return {
          contentClientHeight: content.clientHeight,
          contentOverflowY: getComputedStyle(content).overflowY,
          contentScrollHeight: content.scrollHeight,
          inspectorClientHeight: inspectorElement.clientHeight,
          inspectorScrollHeight: inspectorElement.scrollHeight,
        };
      });
      expect(mobileLayout.contentOverflowY).toBe("auto");
      expect(mobileLayout.contentScrollHeight).toBeGreaterThan(mobileLayout.contentClientHeight);
      expect(mobileLayout.inspectorScrollHeight).toBeLessThanOrEqual(
        mobileLayout.inspectorClientHeight + 1,
      );
    } finally {
      await context.close();
    }
  });

  it("renders empty, typed unavailable, corrupt, and expired results without guessing", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["audit.run.inspect"],
      methodResponses: {
        "audit.run.inspect": {
          cases: [
            {
              match: { runId: "missing" },
              response: unavailableResult({ state: "unknown", reasonCode: "run_not_found" }),
            },
            {
              match: { runId: "expired" },
              response: unavailableResult({
                state: "unsupported",
                reasonCode: "identity_context_unavailable",
                remediation: [
                  {
                    code: "run_again_after_expiry",
                    text: "This run is outside the 30-day retention window.",
                  },
                ],
              }),
            },
            {
              match: { runId: "corrupt" },
              response: unavailableResult({
                state: "unknown",
                reasonCode: "identity_context_corrupt",
              }),
            },
            {
              match: { runId: "ambiguous", executionCursor: "50" },
              response: ambiguousResult("ambiguous", "execution-candidate-51"),
            },
            {
              match: { runId: "ambiguous" },
              response: ambiguousResult("ambiguous", "execution-candidate-1", "50"),
            },
            {
              match: { executionId: "execution-candidate-1" },
              response: presentResult("ambiguous", "execution-candidate-1"),
            },
            {
              match: { executionId: "execution-candidate-51" },
              response: presentResult("ambiguous", "execution-candidate-51"),
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}activity?view=run`);
      await page.getByRole("heading", { name: "No run selected" }).waitFor();
      expect((await gateway.getRequests("audit.run.inspect")).length).toBe(0);
      await screenshot(page, "02-empty.png");

      for (const [runId, heading, screenshotName] of [
        ["missing", "Run not found", "03-not-found.png"],
        ["expired", "Identity evidence expired", "04-expired.png"],
        ["corrupt", "Identity evidence is corrupt", "05-corrupt.png"],
      ] as const) {
        await page.goto(`${server.baseUrl}activity?view=run&run=${runId}`);
        await page.getByRole("heading", { name: heading }).waitFor();
        await screenshot(page, screenshotName);
      }

      await page.goto(`${server.baseUrl}activity?view=run&run=ambiguous`);
      await page.getByRole("heading", { name: "Multiple executions match this run" }).waitFor();
      await screenshot(page, "11-ambiguous.png");
      await page.getByRole("button", { name: "Load more executions" }).click();
      await page.getByRole("link", { name: "execution-candidate-51" }).waitFor();
      expect((await gateway.getRequests("audit.run.inspect")).at(-1)?.params).toEqual({
        runId: "ambiguous",
        executionCursor: "50",
        decisionLimit: 50,
        executionLimit: 50,
      });
      expect(await page.getByRole("button", { name: "Load more executions" }).count()).toBe(0);
      await page.getByRole("link", { name: "execution-candidate-51" }).click();
      await page.getByRole("heading", { name: "Identity and authority" }).waitFor();
      expect(new URL(page.url()).searchParams.get("execution")).toBe("execution-candidate-51");
      expect((await gateway.getRequests("audit.run.inspect")).at(-1)?.params).toEqual({
        executionId: "execution-candidate-51",
        decisionLimit: 50,
      });
      await screenshot(page, "12-exact-selection.png");
    } finally {
      await context.close();
    }
  });

  it("shows loading, request failure, retry, and disconnected states", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const runId = "retry-run";
    const gateway = await installMockGateway(page, {
      featureMethods: ["audit.run.inspect"],
      deferredMethods: ["audit.run.inspect"],
      methodResponses: { "audit.run.inspect": presentResult(runId) },
    });

    try {
      await page.goto(`${server.baseUrl}activity?view=run&run=${runId}`);
      await page.getByRole("heading", { name: "Loading run inspection" }).waitFor();
      await screenshot(page, "06-loading.png");
      await gateway.rejectDeferred("audit.run.inspect", {
        code: "UNAVAILABLE",
        message: "temporarily unavailable",
        retryable: true,
      });
      await page.getByRole("heading", { name: "Run inspection failed" }).waitFor();
      await screenshot(page, "07-error.png");
      await page.getByRole("button", { name: "Retry inspection" }).click();
      await page.getByRole("heading", { name: "Identity and authority" }).waitFor();

      await gateway.closeLatest(1006, "network unavailable");
      await page.getByRole("heading", { name: "Gateway disconnected" }).waitFor();
      await screenshot(page, "08-disconnected.png");
    } finally {
      await context.close();
    }
  });

  it("distinguishes missing access from an older unsupported Gateway", async () => {
    for (const scenario of [
      {
        name: "unauthorized",
        featureMethods: ["audit.run.inspect"],
        operatorScopes: ["operator.approvals"],
        heading: "Operator read access required",
        screenshotName: "09-unauthorized.png",
      },
      {
        name: "unsupported",
        featureMethods: ["chat.startup"],
        operatorScopes: ["operator.read"],
        heading: "Run inspection unsupported",
        screenshotName: "10-unsupported-gateway.png",
      },
    ] as const) {
      const context = await newContext();
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: [...scenario.featureMethods],
        operatorScopes: [...scenario.operatorScopes],
      });
      try {
        await page.goto(`${server.baseUrl}activity?view=run&run=${scenario.name}`);
        await page.getByRole("heading", { name: scenario.heading }).waitFor();
        expect((await gateway.getRequests("audit.run.inspect")).length).toBe(0);
        await screenshot(page, scenario.screenshotName);
      } finally {
        await context.close();
      }
    }
  });
});
