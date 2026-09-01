import path from "node:path";
import type { QuestionRecord } from "@openclaw/gateway-protocol";
import { beforeEach, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Home attention",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const mainSessionKey = "agent:main:main";
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofVariant = process.env.OPENCLAW_HOME_ATTENTION_PROOF_VARIANT || "candidate";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = path.join(createControlUiE2eArtifactDir("home-attention"), proofVariant);
  }
});

function sessionsList(row: GatewaySessionRow): SessionsListResult {
  return {
    ts: Date.now(),
    path: "",
    count: 1,
    defaults: { modelProvider: "openai", model: "gpt-5.6-luna", contextTokens: null },
    sessions: [row],
  };
}

function sessionRow(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: mainSessionKey,
    kind: "direct",
    label: "Home",
    displayName: "Quiet control state",
    updatedAt: Date.now(),
    status: "done",
    ...overrides,
  };
}

async function publishSessionRow(
  gateway: MockGatewayControls,
  row: GatewaySessionRow,
): Promise<void> {
  await gateway.setMethodResponse("sessions.list", sessionsList(row));
  const requestCount = (await gateway.getRequests("sessions.list")).length;
  await gateway.emitGatewayEvent("sessions.changed", {
    key: row.key,
    reason: "home-attention-proof",
    updatedAt: row.updatedAt,
  });
  await expect
    .poll(async () => (await gateway.getRequests("sessions.list")).length)
    .toBeGreaterThan(requestCount);
}

async function captureState(
  page: import("playwright").Page,
  home: import("playwright").Locator,
  name: string,
): Promise<number> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  if (captureUiProof) {
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: path.join(proofDir, `${name}.png`),
    });
  }
  return home.locator("[data-session-attention]").count();
}

suite.define(() => {
  it("projects question, failure, and agent-declared attention onto Home", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProof
        ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["question.get", "question.list", "question.resolve"],
      methodResponses: {
        "question.list": { questions: [] },
        "sessions.list": sessionsList(sessionRow()),
      },
      sessionKey: mainSessionKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainSessionKey));
    await gateway.waitForRequest("sessions.list");
    const home = page.locator(".nav-item--home");
    await home.waitFor();
    const observed = {
      quiet: await captureState(page, home, "00-non-attention"),
      agent: 0,
      question: 0,
      error: 0,
    };

    await publishSessionRow(
      gateway,
      sessionRow({
        displayName: "Declared attention state",
        status: "running",
        hasActiveRun: true,
        agentStatus: {
          note: "Blocked: operator input required",
          attention: "flag",
          expiresAt: Date.now() + 60_000,
        },
      }),
    );
    observed.agent = await captureState(page, home, "01-agent-declared-attention");

    const now = Date.now();
    const question = {
      id: "home-attention-question",
      agentId: "main",
      sessionKey: mainSessionKey,
      questions: [
        {
          questionId: "continue_run",
          header: "Continue",
          question: "Should the run continue?",
          options: [{ label: "Continue", description: "Resume the waiting run." }],
        },
      ],
      createdAtMs: now,
      expiresAtMs: now + 60_000,
      status: "pending",
    } satisfies QuestionRecord;
    await gateway.emitGatewayEvent("question.requested", question);
    await page.getByText("Should the run continue?", { exact: true }).waitFor();
    observed.question = await captureState(page, home, "02-question-attention");

    await gateway.emitGatewayEvent("question.resolved", {
      id: question.id,
      status: "cancelled",
    });
    await expect
      .poll(() => page.getByText("Should the run continue?", { exact: true }).count())
      .toBe(0);
    await publishSessionRow(
      gateway,
      sessionRow({
        displayName: "Failed run state",
        endedAt: Date.now(),
        lastRunError: "Release validation failed",
        status: "failed",
      }),
    );
    observed.error = await captureState(page, home, "03-failed-run-attention");

    expect(observed).toEqual({ quiet: 0, agent: 1, question: 1, error: 1 });
  });
});
