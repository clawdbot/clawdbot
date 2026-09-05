import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { AuditRunInspectResult } from "../../../packages/gateway-protocol/src/schema/audit-run.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  decisionDisplay,
  presentResult,
  receiptPage,
} from "./activity-run-inspector.test-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI durable Activity run inspector",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("activity-run-inspector-r6");
  }
});

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
    decisionDisplays: [],
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
    decisionDisplays: [],
    coverage: { state: "unknown", missingEvidence: ["execution.selection"] },
    ...(nextExecutionCursor ? { nextExecutionCursor } : {}),
  };
}

async function newContext(options: { video?: boolean } = {}): Promise<BrowserContext> {
  if (captureUiProof) {
    await mkdir(path.join(proofDir, "video"), { recursive: true });
  }
  return suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 1000, width: 1440 },
    ...(captureUiProof && options.video
      ? { recordVideo: { dir: path.join(proofDir, "video"), size: { height: 1000, width: 1440 } } }
      : {}),
  });
}

async function screenshot(
  page: Page,
  name: string,
  content = page.getByRole("heading", { name: "Identity and authority" }),
) {
  if (!captureUiProof) {
    return;
  }
  if (page.video()) {
    await content.scrollIntoViewIfNeeded();
    await writeFile(
      path.join(proofDir, name),
      await takeControlUiViewportScreenshot(page, page.locator(".run-inspector"), [content]),
    );
    return;
  }
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

suite.define(() => {
  it("deep-links, reloads durable evidence, and exposes text-first accessible states", async () => {
    const context = await newContext({ video: true });
    const page = await context.newPage();
    const runId = "run:durable/one";
    const gateway = await installMockGateway(page, {
      featureMethods: ["audit.run.inspect"],
      methodResponses: { "audit.run.inspect": presentResult(runId) },
    });

    try {
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=${encodeURIComponent(runId)}`);
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
      await suite.closeBrowserContext(context);
    }
  });

  it("pages, deep-links, and safely explains approval and unsupported receipts", async () => {
    const privateApprovalReceiptId = "U2_R6_BROWSER_APPROVAL_RECEIPT_ID_SECRET_315c";
    const privateResolutionRef = "U2_R6_BROWSER_RESOLUTION_REF_SECRET_f907";
    const privateMessageReceiptId = "U2_R6_BROWSER_MESSAGE_RECEIPT_ID_SECRET_761e";
    const privateEventId = "U2_R6_BROWSER_EVENT_ID_SECRET_b442";
    const allowed = decisionDisplay({
      id: "approval-decision:101",
      summary: "An exec approval allowed the requested action.",
      outcome: "allowed",
      reasonCode: "operator_approval_allowed_by_reviewer",
      coverageState: "enforced",
      remediation: "No follow-up is required.",
    });
    const denied = decisionDisplay({
      id: "approval-decision:102",
      summary: "An exec approval stopped the requested action.",
      outcome: "denied",
      reasonCode: "operator_approval_denied_by_reviewer",
      coverageState: "enforced",
      remediation: "Review the denial before requesting a new action.",
    });
    Object.assign(denied, {
      receiptId: privateApprovalReceiptId,
      resolutionRef: privateResolutionRef,
      command: "rm -rf /private/operator-path",
      arguments: { token: "credential-value" },
      payload: "raw-payload",
    });
    const expired = decisionDisplay({
      id: "approval-decision:103",
      summary: "An exec approval expired before a decision arrived.",
      outcome: "denied",
      reasonCode: "operator_approval_expired",
      coverageState: "enforced",
      remediation: "Request the action again and resolve the new approval before its deadline.",
    });
    const cancelled = decisionDisplay({
      id: "approval-decision:104",
      summary: "An exec approval was cancelled when the run ended.",
      outcome: "denied",
      reasonCode: "operator_approval_cancelled_run_aborted",
      coverageState: "enforced",
      remediation: "Start a new run if the action is still needed.",
    });
    const unknown = decisionDisplay({
      id: "approval-decision:105",
      summary: "A retained approval could not be bound to this execution.",
      outcome: "unknown",
      reasonCode: "operator_approval_execution_link_missing",
      coverageState: "unknown",
      remediation: "Inspect the exact retained binding before trusting attribution.",
    });
    const unsupported = decisionDisplay({
      id: "approval-decision:106",
      summary: "This observation has no Phase 0 enforcement contract.",
      outcome: "not-applicable",
      reasonCode: "observation_enforcement_unsupported",
      coverageState: "unsupported",
      remediation: "Treat this as an observation, not an authorization decision.",
    });
    const delivered = decisionDisplay({
      id: "message-decision:2000000000007",
      summary: "An outbound message was delivered.",
      outcome: "allowed",
      reasonCode: "message_delivered",
      coverageState: "attribution-only",
      remediation: "No follow-up is required.",
      producer: "message-delivery",
      family: "message",
      operation: "send",
    });
    Object.assign(delivered, {
      receiptId: privateMessageReceiptId,
      eventId: privateEventId,
    });
    const firstPage = receiptPage([allowed, denied], "a:10:2");
    const secondPage = receiptPage([expired, cancelled, unknown, unsupported, delivered]);
    const context = await newContext();
    await context.addInitScript(() => {
      const recordedUrls: string[] = [];
      const instrument = (method: "pushState" | "replaceState") => {
        const original = history[method].bind(history);
        history[method] = ((data: unknown, unused: string, url?: string | URL | null) => {
          if (url !== undefined && url !== null) {
            recordedUrls.push(String(url));
          }
          original(data, unused, url);
        }) as History[typeof method];
      };
      instrument("pushState");
      instrument("replaceState");
      Object.defineProperty(window, "activityHistoryUrls", { value: recordedUrls });
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["audit.run.inspect"],
      methodResponses: {
        "audit.run.inspect": {
          cases: [
            { match: { decisionCursor: "a:10:2" }, response: secondPage },
            { match: { runId: "receipt-matrix" }, response: firstPage },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=receipt-matrix`);
      await page.getByRole("list", { name: "Decision receipt list" }).waitFor();
      await page.getByRole("heading", { name: "Receipt detail" }).waitFor();
      await page.getByText("Allowed", { exact: true }).first().waitFor();
      await page.getByText("Enforced", { exact: true }).first().waitFor();
      await page.getByText("operator_approval_allowed_by_reviewer", { exact: true }).waitFor();
      await page.getByText("Display provenance", { exact: true }).waitFor();
      await page.getByText("Verified producer", { exact: true }).waitFor();
      await page.getByText("operator-approval", { exact: true }).waitFor();
      await page.getByText("No follow-up is required.", { exact: true }).waitFor();
      expect(
        await page
          .getByText("Policy references used", { exact: true })
          .locator("xpath=following-sibling::dd")
          .textContent(),
      ).toBe("1");
      expect(
        await page
          .getByText("Grant references used", { exact: true })
          .locator("xpath=following-sibling::dd")
          .textContent(),
      ).toBe("1");

      const deniedLink = page.getByText(denied.action.summary!, { exact: true }).locator("..");
      await deniedLink.focus();
      await page.keyboard.press("Enter");
      await page.getByText("operator_approval_denied_by_reviewer", { exact: true }).waitFor();
      expect(new URL(page.url()).searchParams.get("receipt")).toBe("approval-decision:102");
      await page.reload();
      await page.getByText("operator_approval_denied_by_reviewer", { exact: true }).waitFor();

      await page.getByRole("button", { name: "Load more receipts" }).click();
      expect((await gateway.getRequests("audit.run.inspect")).at(-1)?.params).toMatchObject({
        runId: "receipt-matrix",
        decisionCursor: "a:10:2",
        decisionLimit: 50,
      });
      await page.getByText(expired.action.summary!, { exact: true }).click();
      await page.getByText("operator_approval_expired", { exact: true }).waitFor();
      const selectedUrl = new URL(page.url());
      expect(selectedUrl.searchParams.get("receipt")).toBe("approval-decision:103");
      expect(selectedUrl.searchParams.get("decision")).toBe("a:10:2");
      await page.reload();
      await page.getByText("operator_approval_expired", { exact: true }).waitFor();
      expect((await gateway.getRequests("audit.run.inspect")).at(-1)?.params).toMatchObject({
        runId: "receipt-matrix",
        decisionCursor: "a:10:2",
        decisionLimit: 50,
      });

      for (const [receipt, reasonCode] of [
        [cancelled, "operator_approval_cancelled_run_aborted"],
        [unknown, "operator_approval_execution_link_missing"],
        [unsupported, "observation_enforcement_unsupported"],
      ] as const) {
        await page.getByText(receipt.action.summary!, { exact: true }).click();
        await page.getByText(reasonCode, { exact: true }).waitFor();
      }
      await page.getByText("Unknown", { exact: true }).first().waitFor();
      await page.getByText("Unsupported", { exact: true }).first().waitFor();
      await page.getByText(delivered.action.summary!, { exact: true }).click();
      await page.getByText("message_delivered", { exact: true }).waitFor();
      expect(new URL(page.url()).searchParams.get("receipt")).toBe(
        "message-decision:2000000000007",
      );
      const surfaces = await page.locator("body").evaluate((body) => {
        const elements = [body, ...body.querySelectorAll<HTMLElement>("*")];
        const historyUrls = (window as typeof window & { activityHistoryUrls?: readonly string[] })
          .activityHistoryUrls;
        return {
          // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText separately proves rendered visible text.
          visibleText: body instanceof HTMLElement ? body.innerText : "",
          textContent: body.textContent ?? "",
          aria: elements
            .flatMap((element) =>
              ["aria-label", "aria-labelledby", "aria-describedby", "title", "alt"].map((name) =>
                element.getAttribute(name),
              ),
            )
            .filter((value): value is string => value !== null)
            .join("\n"),
          hrefs: elements
            .filter((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement)
            .flatMap((link) => [link.getAttribute("href") ?? "", link.href])
            .join("\n"),
          location: location.href,
          historyState: JSON.stringify(history.state),
          historyUrls: [...(historyUrls ?? [])].join("\n"),
        };
      });
      const accessibilityTree = await page.locator("body").ariaSnapshot();
      for (const hidden of [
        "hidden-action-id",
        "hidden-resource-id",
        "hidden-target-id",
        "hidden-evaluator-id",
        "hidden-policy-id",
        "hidden-grant-id",
        "hidden-record-id",
        "rm -rf",
        "/private/operator-path",
        "credential-value",
        "raw-payload",
        privateApprovalReceiptId,
        privateResolutionRef,
        privateMessageReceiptId,
        privateEventId,
      ]) {
        for (const surface of [...Object.values(surfaces), accessibilityTree]) {
          expect(surface).not.toContain(hidden);
        }
      }
      await screenshot(page, "16-receipt-detail-message.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("renders the Gateway's unverified receipt state without claiming a verified producer", async () => {
    const response = receiptPage([
      {
        schemaVersion: 1,
        selectorId: "decision-fact:1",
        occurredAt: 1_786_000_000_000,
        action: { family: "decision", operation: "record" },
        decision: { outcome: "unknown", reasonCode: "decision_fact_display_unverified" },
        enforcement: {
          coverageState: "unknown",
          policyCount: 0,
          grantCount: 0,
          contextFieldsUsed: [],
        },
        provenance: { state: "unverified" },
        missingEvidence: ["decision.display_provenance"],
        remediation: [],
      },
    ]);

    const context = await newContext({ video: true });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["audit.run.inspect"],
      methodResponses: { "audit.run.inspect": response },
    });

    try {
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=receipt-matrix`);
      await page.getByRole("heading", { name: "Receipt detail" }).waitFor();
      await page.getByText("Unknown", { exact: true }).first().waitFor();
      await page
        .getByText("Receipt-controlled explanations and next steps are hidden", {
          exact: false,
        })
        .waitFor();
      expect(
        await page
          .getByText("Policy references used", { exact: true })
          .locator("xpath=following-sibling::dd")
          .textContent(),
      ).toBe("0");
      expect(
        await page
          .getByText("Grant references used", { exact: true })
          .locator("xpath=following-sibling::dd")
          .textContent(),
      ).toBe("0");

      const detail = page.locator(".run-inspector__receipt-detail");
      await detail.getByText("decision_fact_display_unverified", { exact: true }).waitFor();
      await detail.getByText("decision.display_provenance", { exact: true }).waitFor();
      expect(await detail.getByText("Verified producer", { exact: true }).count()).toBe(0);
      await screenshot(
        page,
        "18-unverified-receipt-privacy.png",
        detail.getByText("decision_fact_display_unverified", { exact: true }),
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps loaded receipts visible when later-page inspection fails", async () => {
    const context = await newContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["audit.run.inspect"],
      methodResponses: {
        "audit.run.inspect": {
          cases: [
            {
              match: { decisionCursor: "a:10:2" },
              response: {
                __mockError: {
                  code: "INVALID_REQUEST",
                  message: "decision cursor is no longer retained",
                },
              },
            },
            {
              match: { runId: "receipt-page-error" },
              response: {
                ...receiptPage(
                  [
                    decisionDisplay({
                      id: "approval-decision:107",
                      summary: "A denied approval remains visible.",
                      outcome: "denied",
                      reasonCode: "operator_approval_denied_by_reviewer",
                      coverageState: "enforced",
                      remediation: "Review the recorded denial.",
                    }),
                  ],
                  "a:10:2",
                ),
                run: {
                  runId: "receipt-page-error",
                  executionId: "execution-safe-ref",
                  status: "known",
                },
              },
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=receipt-page-error`);
      await page.getByText("A denied approval remains visible.", { exact: true }).first().waitFor();
      await page.getByRole("button", { name: "Load more receipts" }).click();
      await page
        .getByRole("alert")
        .getByText("More receipts could not be loaded", { exact: false })
        .waitFor();
      await page.getByText("A denied approval remains visible.", { exact: true }).first().waitFor();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("restarts stale receipt deep links on page one while preserving the exact selector", async () => {
    for (const scenario of [
      { kind: "run", id: "run:stale/deep-link" },
      { kind: "execution", id: "execution:stale/deep-link" },
    ] as const) {
      const context = await newContext();
      const page = await context.newPage();
      const receiptId = `private-receipt-${scenario.kind}`;
      const decisionCursor = `a:1786000000000:${scenario.kind === "run" ? "41" : "42"}`;
      const firstPage = presentResult(
        scenario.kind === "run" ? scenario.id : "run-for-exact-execution",
        scenario.kind === "execution" ? scenario.id : "execution-for-run",
      );
      const gateway = await installMockGateway(page, {
        featureMethods: ["audit.run.inspect"],
        methodResponses: {
          "audit.run.inspect": {
            cases: [
              {
                match: { decisionCursor },
                response: {
                  __mockError: {
                    code: "INVALID_REQUEST",
                    message: "decision cursor is no longer retained",
                  },
                },
              },
              { match: { [`${scenario.kind}Id`]: scenario.id }, response: firstPage },
            ],
          },
        },
      });

      try {
        const search = new URLSearchParams({
          view: "run",
          [scenario.kind]: scenario.id,
          receipt: receiptId,
          decision: decisionCursor,
        });
        await page.goto(`${suite.server.baseUrl}activity?${search.toString()}`);
        await page.getByRole("heading", { name: "Run inspection failed" }).waitFor();
        const restart = page.getByRole("button", { name: "Restart inspection" });
        await restart.waitFor();
        expect(await page.getByRole("button", { name: "Retry inspection" }).count()).toBe(0);
        const errorText = (await page.locator(".run-inspector__panel").textContent()) ?? "";
        expect(errorText).not.toContain(receiptId);
        expect(errorText).not.toContain(decisionCursor);

        const requestCount = (await gateway.getRequests("audit.run.inspect")).length;
        await restart.focus();
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim()))
          .toBe("Restart inspection");
        await page.keyboard.press("Enter");
        await page.getByRole("heading", { name: "Identity and authority" }).waitFor();
        const request = await gateway.waitForRequest("audit.run.inspect", { after: requestCount });
        const expectedParams = {
          [`${scenario.kind}Id`]: scenario.id,
          decisionLimit: 50,
          ...(scenario.kind === "run" ? { executionLimit: 50 } : {}),
        };
        expect(request.params).toEqual(expectedParams);
        expect(request.params).not.toHaveProperty("decisionCursor");
        const restartedUrl = new URL(page.url());
        expect(restartedUrl.searchParams.get(scenario.kind)).toBe(scenario.id);
        expect(restartedUrl.searchParams.get(scenario.kind === "run" ? "execution" : "run")).toBe(
          null,
        );
        expect(restartedUrl.searchParams.get("receipt")).toBeNull();
        expect(restartedUrl.searchParams.get("decision")).toBeNull();
      } finally {
        await suite.closeBrowserContext(context);
      }
    }
  });

  it("keeps a populated Live activity stream bounded after adding the mode switcher", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, { sessionKey: "main" });

    try {
      await page.goto(`${suite.server.baseUrl}activity?view=live`);
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
      await suite.closeBrowserContext(context);
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
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=${encodeURIComponent(runId)}`);
      const inspector = page.locator(".run-inspector");
      const finalReceiptContent = page.getByText(
        "Treat this receipt as attribution only; it does not prove authorization.",
        { exact: true },
      );
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
      await suite.closeBrowserContext(context);
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
      await page.goto(`${suite.server.baseUrl}activity?view=run`);
      await page.getByRole("heading", { name: "No run selected" }).waitFor();
      expect((await gateway.getRequests("audit.run.inspect")).length).toBe(0);
      await screenshot(page, "02-empty.png");

      for (const [runId, heading, screenshotName] of [
        ["missing", "Run not found", "03-not-found.png"],
        ["expired", "Identity evidence expired", "04-expired.png"],
        ["corrupt", "Identity evidence is corrupt", "05-corrupt.png"],
      ] as const) {
        await page.goto(`${suite.server.baseUrl}activity?view=run&run=${runId}`);
        await page.getByRole("heading", { name: heading }).waitFor();
        await screenshot(page, screenshotName);
      }

      await page.goto(`${suite.server.baseUrl}activity?view=run&run=ambiguous`);
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
      await suite.closeBrowserContext(context);
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
      await page.goto(`${suite.server.baseUrl}activity?view=run&run=${runId}`);
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
      await suite.closeBrowserContext(context);
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
        await page.goto(`${suite.server.baseUrl}activity?view=run&run=${scenario.name}`);
        await page.getByRole("heading", { name: scenario.heading }).waitFor();
        expect((await gateway.getRequests("audit.run.inspect")).length).toBe(0);
        await screenshot(page, scenario.screenshotName);
      } finally {
        await suite.closeBrowserContext(context);
      }
    }
  });
});
