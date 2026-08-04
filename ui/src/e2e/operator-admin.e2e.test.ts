// Control UI E2E coverage for operator-facing Skills, Nodes, and exec approvals administration.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "operator-admin");
const viewport = { height: 960, width: 1440 };

let browser: Browser;
let server: ControlUiE2eServer;

const agentRoster = [
  { id: "main", identity: { name: "Main" }, name: "Main" },
  { id: "reviewer", identity: { name: "Reviewer" }, name: "Reviewer" },
];

const operatorConfig = {
  agents: {
    entries: {
      main: { default: true, name: "Main" },
      reviewer: { name: "Reviewer" },
    },
  },
};

function skillStatus(eligible: boolean) {
  return {
    workspaceDir: "/tmp/openclaw-e2e/workspace",
    managedSkillsDir: "/tmp/openclaw-e2e/skills",
    skills: [
      {
        name: "Deploy Helper",
        description: "Prepare reviewed deployments.",
        source: "openclaw-bundled",
        bundled: true,
        filePath: "/tmp/openclaw-e2e/skills/deploy-helper/SKILL.md",
        baseDir: "/tmp/openclaw-e2e/skills/deploy-helper",
        skillKey: "deploy-helper",
        always: false,
        disabled: false,
        blockedByAllowlist: false,
        blockedByAgentFilter: false,
        eligible,
        platformIncompatible: false,
        modelVisible: eligible,
        userInvocable: true,
        commandVisible: eligible,
        requirements: {
          bins: ["deploy-helper"],
          anyBins: [],
          env: [],
          config: [],
          os: [],
        },
        missing: {
          bins: eligible ? [] : ["deploy-helper"],
          anyBins: [],
          env: [],
          config: [],
          os: [],
        },
        configChecks: [],
        install: [
          {
            id: "node-deploy-helper",
            kind: "node",
            label: "Install Deploy Helper",
            bins: ["deploy-helper"],
          },
        ],
      },
    ],
  };
}

function configResponse() {
  const raw = JSON.stringify(operatorConfig);
  return {
    config: operatorConfig,
    sourceConfig: operatorConfig,
    hash: "config-hash-1",
    issues: [],
    raw,
    valid: true,
  };
}

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    return {};
  }
  return request.params as Record<string, unknown>;
}

async function waitForRequest(
  gateway: MockGatewayControls,
  method: string,
  predicate: (params: Record<string, unknown>) => boolean,
) {
  await expect
    .poll(async () =>
      (await gateway.getRequests(method)).some((request) => predicate(requestParams(request))),
    )
    .toBe(true);
}

async function createContext(): Promise<BrowserContext> {
  if (captureUiProof) {
    await mkdir(proofDir, { recursive: true });
  }
  return browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(captureUiProof ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
  });
}

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

describeControlUiE2e("Control UI operator administration", () => {
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

  it("administers agent-scoped Skills and inspects the connected Nodes inventory", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "skills.install", "skills.update"],
      methodResponses: {
        "agents.list": {
          agents: agentRoster,
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": configResponse(),
        "device.pair.list": { paired: [], pending: [] },
        "exec.approvals.get": {
          path: "/tmp/openclaw-e2e/exec-approvals.json",
          exists: true,
          hash: "approval-hash-1",
          file: {
            defaults: {
              security: "deny",
              ask: "on-miss",
              askFallback: "deny",
              autoAllowSkills: false,
            },
            agents: {},
          },
        },
        "node.list": {
          nodes: [
            {
              nodeId: "build-node",
              displayName: "Build Node",
              platform: "linux",
              version: "2026.8.3",
              caps: ["browser", "filesystem"],
              commands: ["system.run", "system.execApprovals.get", "system.execApprovals.set"],
              connected: true,
              paired: true,
            },
          ],
        },
        "skills.install": { message: "Installed Deploy Helper" },
        "skills.status": {
          cases: [
            { match: { agentId: "reviewer" }, response: skillStatus(false) },
            { response: skillStatus(true) },
          ],
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}skills`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("skills.status");

      const agentSelect = page.locator('openclaw-agent-select[name="skills-agent"]');
      await agentSelect.locator(".agent-select__trigger").click();
      await agentSelect
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Reviewer" })
        .click();
      await waitForRequest(gateway, "skills.status", (params) => params.agentId === "reviewer");
      await expect
        .poll(async () => (await agentSelect.locator(".agent-select__label").textContent())?.trim())
        .toBe("Reviewer");

      await page.getByRole("button", { name: "Open Deploy Helper details" }).click();
      const dialog = page.locator("openclaw-modal-dialog", { hasText: "Deploy Helper" });
      await expect
        .poll(() => dialog.getByRole("button", { name: "Install Deploy Helper" }).isVisible())
        .toBe(true);
      await gateway.setMethodResponse("skills.status", skillStatus(true));
      await dialog.getByRole("button", { name: "Install Deploy Helper" }).click();
      const installRequest = await gateway.waitForRequest("skills.install");
      expect(installRequest.params).toMatchObject({
        agentId: "reviewer",
        name: "Deploy Helper",
        installId: "node-deploy-helper",
        dangerouslyForceUnsafeInstall: false,
      });
      await expect.poll(() => dialog.getByText("Installed Deploy Helper").isVisible()).toBe(true);
      await screenshot(page, "01-reviewer-skill-installed.png");

      await page.goto(`${server.baseUrl}nodes`);
      await Promise.all([
        gateway.waitForRequest("node.list"),
        gateway.waitForRequest("device.pair.list"),
        gateway.waitForRequest("exec.approvals.get"),
      ]);
      await expect.poll(() => page.getByText("Build Node", { exact: true }).isVisible()).toBe(true);
      await expect.poll(() => page.getByText("connected", { exact: true }).isVisible()).toBe(true);
      await page.getByText("Details", { exact: true }).click();
      await expect
        .poll(() => page.getByText(/Capabilities: browser, filesystem/).isVisible())
        .toBe(true);
      await expect
        .poll(() =>
          page
            .getByText(
              /Commands: system\.run, system\.execApprovals\.get, system\.execApprovals\.set/,
            )
            .isVisible(),
        )
        .toBe(true);
      await screenshot(page, "02-connected-node-inventory.png");
    } finally {
      await context.close();
    }
  });

  it("keeps read-only administration pages visible without dispatching mutations", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const proposal = {
      id: "proposal-read-only",
      kind: "create",
      status: "pending",
      title: "Read Only Proposal",
      description: "Review without mutation access.",
      skillName: "Read Only Proposal",
      skillKey: "read-only-proposal",
      createdAt: "2026-08-04T08:00:00.000Z",
      updatedAt: "2026-08-04T08:00:00.000Z",
      scanState: "clean",
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "agents.files.set",
        "agents.update",
        "chat.metadata",
        "chat.startup",
        "config.patch",
        "config.set",
        "openclaw.chat",
        "skills.install",
        "skills.proposals.apply",
        "skills.proposals.evaluate",
        "skills.proposals.historyScan",
        "skills.proposals.reject",
        "skills.proposals.requestRevision",
        "skills.update",
      ],
      operatorScopes: ["operator.read"],
      methodResponses: {
        "agents.list": {
          agents: agentRoster,
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "config.get": configResponse(),
        "skills.proposals.inspect": {
          content: "Review the proposed skill.",
          record: {
            ...proposal,
            proposedVersion: "v1",
            target: { skillKey: proposal.skillKey, skillName: proposal.skillName },
          },
          supportFiles: [],
        },
        "skills.proposals.list": {
          proposals: [proposal],
          schema: "openclaw.skill-workshop.proposals-manifest.v1",
          updatedAt: proposal.updatedAt,
        },
        "skills.status": skillStatus(false),
      },
    });

    try {
      await page.goto(`${server.baseUrl}agents`);
      await gateway.waitForRequest("agents.list");
      const setDefault = page.locator(".agents-toolbar-actions button").nth(1);
      await expect.poll(() => setDefault.isDisabled()).toBe(true);
      await setDefault.click({ force: true });
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      await screenshot(page, "05-read-only-agents.png");

      await page.goto(`${server.baseUrl}skills`);
      await gateway.waitForRequest("skills.status");
      await page.getByRole("button", { name: "Open Deploy Helper details" }).click();
      const skillDialog = page.locator("openclaw-modal-dialog", { hasText: "Deploy Helper" });
      const install = skillDialog.getByRole("button", { name: "Install Deploy Helper" });
      await expect.poll(() => install.isDisabled()).toBe(true);
      await install.click({ force: true });
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
      await screenshot(page, "06-read-only-skills.png");

      await page.goto(`${server.baseUrl}skills/workshop`);
      await gateway.waitForRequest("skills.proposals.list");
      await page.locator("#skill-workshop-mode-tab-board").click();
      const actionButtons = page.locator(".sw-action-bar button");
      const evaluate = actionButtons.nth(0);
      const apply = actionButtons.nth(1);
      await expect.poll(() => apply.isDisabled()).toBe(true);
      await expect.poll(() => evaluate.isDisabled()).toBe(true);
      await apply.click({ force: true });
      await evaluate.click({ force: true });
      expect(await gateway.getRequests("skills.proposals.apply")).toHaveLength(0);
      expect(await gateway.getRequests("skills.proposals.evaluate")).toHaveLength(0);
      await screenshot(page, "07-read-only-workshop.png");

      await page.goto(`${server.baseUrl}custodian?intent=new-agent`);
      await page.locator("openclaw-custodian-page").waitFor();
      expect(await gateway.getRequests("openclaw.chat")).toHaveLength(0);
      await screenshot(page, "08-read-only-new-agent.png");
    } finally {
      await context.close();
    }
  });

  it("edits, saves, and reapplies reviewer-scoped exec approvals", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const initialApprovals = {
      path: "/tmp/openclaw-e2e/exec-approvals.json",
      exists: true,
      hash: "approval-hash-1",
      file: {
        defaults: {
          security: "deny",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        agents: {
          reviewer: {
            security: "allowlist",
            ask: "on-miss",
            askFallback: "deny",
            autoAllowSkills: false,
            allowlist: [{ pattern: "/usr/bin/git" }],
          },
        },
      },
    };
    const appliedApprovals = {
      ...initialApprovals,
      hash: "approval-hash-2",
      file: {
        ...initialApprovals.file,
        agents: {
          reviewer: {
            security: "full",
            ask: "always",
            askFallback: "allowlist",
            autoAllowSkills: true,
            allowlist: [{ pattern: "/usr/bin/gh" }],
          },
        },
      },
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": configResponse(),
        "device.pair.list": { paired: [], pending: [] },
        "exec.approvals.get": initialApprovals,
        "exec.approvals.set": { ok: true },
        "node.list": { nodes: [] },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}nodes`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("exec.approvals.get");

      const scopeSelect = page.locator("openclaw-agent-select.agent-select--settings");
      await scopeSelect.locator(".agent-select__trigger").click();
      await scopeSelect
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Reviewer (reviewer)" })
        .click();
      await expect
        .poll(async () => (await scopeSelect.locator(".agent-select__label").textContent())?.trim())
        .toBe("Reviewer (reviewer)");

      const modeSelects = page.getByRole("combobox", { name: "Mode" });
      await modeSelects.nth(0).selectOption("full");
      await modeSelects.nth(1).selectOption("always");
      await page.getByRole("combobox", { name: "Fallback" }).selectOption("allowlist");
      const autoAllowSwitch = page
        .locator(".settings-row", { hasText: "Auto-allow skill CLIs" })
        .locator("wa-switch");
      await autoAllowSwitch.click();
      await page.getByRole("textbox", { name: "Pattern" }).fill("/usr/bin/gh");
      await screenshot(page, "03-reviewer-approval-edits.png");

      await gateway.setMethodResponse("exec.approvals.get", appliedApprovals);
      const getRequestsBeforeSave = (await gateway.getRequests("exec.approvals.get")).length;
      const approvalsSection = page.locator(".settings-section", { hasText: "Exec approvals" });
      const saveButton = approvalsSection.getByRole("button", { name: "Save", exact: true });
      await saveButton.click();
      const saveRequest = await gateway.waitForRequest("exec.approvals.set");
      expect(saveRequest.params).toEqual({
        baseHash: "approval-hash-1",
        file: appliedApprovals.file,
      });

      await expect
        .poll(async () => (await gateway.getRequests("exec.approvals.get")).length)
        .toBeGreaterThan(getRequestsBeforeSave);
      await expect.poll(() => modeSelects.nth(0).inputValue()).toBe("full");
      await expect.poll(() => modeSelects.nth(1).inputValue()).toBe("always");
      await expect
        .poll(() => page.getByRole("combobox", { name: "Fallback" }).inputValue())
        .toBe("allowlist");
      await expect
        .poll(() =>
          autoAllowSwitch.evaluate(
            (element) => (element as HTMLElement & { checked: boolean }).checked,
          ),
        )
        .toBe(true);
      await expect
        .poll(() => page.getByRole("textbox", { name: "Pattern" }).inputValue())
        .toBe("/usr/bin/gh");
      await expect.poll(() => saveButton.isDisabled()).toBe(true);
      expect(await page.getByRole("alert").count()).toBe(0);
      await screenshot(page, "04-reviewer-approval-applied.png");
    } finally {
      await context.close();
    }
  });
});
