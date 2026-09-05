// Control UI E2E tests cover visible agent-file save outcomes and agent ownership.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  agentFileProofDir,
  captureAgentFileScreenshot,
  selectAgentFileWorkspace,
} from "./agent-file-lifecycle.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent file lifecycle",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

function fileList(agentId: string) {
  return {
    agentId,
    workspace: `/tmp/openclaw-e2e/workspace-${agentId}`,
    files: [
      {
        name: "AGENTS.md",
        path: `/tmp/openclaw-e2e/workspace-${agentId}/AGENTS.md`,
        missing: false,
      },
    ],
  };
}

function fileGet(agentId: string, content: string) {
  return {
    ...fileList(agentId),
    file: { ...fileList(agentId).files[0], content },
  };
}

function requestAgentId(request: { params?: unknown }) {
  return (request.params as { agentId?: unknown } | undefined)?.agentId;
}

const fileListResponses = {
  cases: [
    { match: { agentId: "main" }, response: fileList("main") },
    { match: { agentId: "writer" }, response: fileList("writer") },
    { response: fileList("main") },
  ],
};

function fileGetResponses(mainContent: string) {
  return {
    cases: [
      {
        match: { agentId: "main", name: "AGENTS.md" },
        response: fileGet("main", mainContent),
      },
      {
        match: { agentId: "writer", name: "AGENTS.md" },
        response: fileGet("writer", "# Writer instructions\n"),
      },
      { response: fileGet("main", mainContent) },
    ],
  };
}

suite.define(() => {
  it("keeps save errors visible, retries, and rejects stale cross-agent reads", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
        ...(agentFileProofDir
          ? { recordVideo: { dir: agentFileProofDir, size: { height: 900, width: 1440 } } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "agents.files.get",
            "agents.files.list",
            "agents.files.set",
            "agents.list",
          ],
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "main", name: "Main" },
                { id: "writer", name: "Writer" },
              ],
            },
            "agents.files.get": fileGetResponses("# Main instructions\n"),
            "agents.files.list": fileListResponses,
            "agents.files.set": {
              __mockError: {
                code: "INTERNAL_ERROR",
                message: "workspace write failed; retry Save",
                retryable: true,
              },
            },
          },
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        });

        await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
        const editor = page.locator(".agent-file-textarea");
        const fileActions = page.locator(".agent-file-actions");
        const reset = fileActions.getByRole("button", { name: "Reset" });
        const save = fileActions.getByRole("button", { name: "Save" });
        const initialRead = await gateway.waitForRequest("agents.files.get");
        expect(initialRead.params).toMatchObject({ agentId: "main", name: "AGENTS.md" });
        await expect.poll(() => editor.inputValue()).toBe("# Main instructions\n");

        await editor.fill("temporary draft");
        await reset.click();
        await expect.poll(() => editor.inputValue()).toBe("# Main instructions\n");

        await editor.fill("Updated main instructions");
        await save.click();
        await expect
          .poll(async () => (await gateway.getRequests("agents.files.set")).length)
          .toBe(1);
        await expect
          .poll(() => page.getByText(/workspace write failed; retry Save/).isVisible())
          .toBe(true);
        expect(await gateway.getRequests("agents.files.list")).toHaveLength(1);
        await captureAgentFileScreenshot(page, "01-save-error-visible.png");

        await gateway.setMethodResponse("agents.files.set", {
          ok: true,
          ...fileGet("main", "Updated main instructions"),
        });
        await save.click();
        await expect
          .poll(async () => (await gateway.getRequests("agents.files.set")).length)
          .toBe(2);
        await expect
          .poll(() => page.getByText(/workspace write failed; retry Save/).count())
          .toBe(0);
        await expect.poll(() => save.isDisabled()).toBe(true);
        await captureAgentFileScreenshot(page, "02-save-retry-succeeded.png");

        await gateway.setMethodResponse(
          "agents.files.get",
          fileGetResponses("Updated main instructions"),
        );
        await gateway.deferNext("agents.files.get", { agentId: "writer", name: "AGENTS.md" });
        await selectAgentFileWorkspace(page, "Writer");
        await expect
          .poll(async () =>
            (await gateway.getRequests("agents.files.get")).some(
              (request) => requestAgentId(request) === "writer",
            ),
          )
          .toBe(true);
        await selectAgentFileWorkspace(page, "Main");
        await expect.poll(() => editor.inputValue()).toBe("Updated main instructions");
        await gateway.resolveDeferred("agents.files.get", fileGet("writer", "stale writer"));
        await expect.poll(() => editor.inputValue()).toBe("Updated main instructions");

        await selectAgentFileWorkspace(page, "Writer");
        await expect.poll(() => editor.inputValue()).toBe("# Writer instructions\n");
        const writes = await gateway.getRequests("agents.files.set");
        expect(writes.every((request) => requestAgentId(request) === "main")).toBe(true);
        await captureAgentFileScreenshot(page, "03-writer-owned-file.png");
      },
    );
  });

  it("preserves drafts and confirmed saves across overlapping refreshes", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
        ...(agentFileProofDir
          ? { recordVideo: { dir: agentFileProofDir, size: { height: 900, width: 1440 } } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "agents.files.get",
            "agents.files.list",
            "agents.files.set",
            "agents.list",
          ],
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [{ id: "main", name: "Main" }],
            },
            "agents.files.get": fileGetResponses("server revision 1"),
            "agents.files.list": fileListResponses,
          },
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
        });

        await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
        const editor = page.locator(".agent-file-textarea");
        const fileSection = page.locator(".settings-section").filter({
          has: page.getByRole("heading", { name: "Core files" }),
        });
        const refresh = fileSection.getByRole("button", { name: "Refresh" });
        const fileActions = page.locator(".agent-file-actions");
        const reset = fileActions.getByRole("button", { name: "Reset" });
        const save = fileActions.getByRole("button", { name: "Save" });
        await expect.poll(() => editor.inputValue()).toBe("server revision 1");
        expect(await gateway.getRequests("agents.files.get")).toHaveLength(1);

        await gateway.setMethodResponse("agents.files.get", fileGetResponses("server revision 2"));
        await refresh.click();
        await expect
          .poll(async () => (await gateway.getRequests("agents.files.get")).length)
          .toBe(2);
        await expect.poll(() => editor.inputValue()).toBe("server revision 2");
        await expect.poll(() => editor.isEnabled()).toBe(true);
        await captureAgentFileScreenshot(page, "04-refresh-adopts-authoritative-content.png");

        await editor.fill("local dirty draft");
        await gateway.setMethodResponse("agents.files.get", fileGetResponses("server revision 3"));
        await refresh.click();
        await expect
          .poll(async () => (await gateway.getRequests("agents.files.get")).length)
          .toBe(3);
        await expect.poll(() => editor.inputValue()).toBe("local dirty draft");
        await expect.poll(() => editor.isEnabled()).toBe(true);
        await expect.poll(() => reset.isEnabled()).toBe(true);
        await captureAgentFileScreenshot(page, "05-refresh-preserves-dirty-draft.png");
        await reset.click();
        await expect.poll(() => editor.inputValue()).toBe("server revision 3");
        await expect.poll(() => reset.isDisabled()).toBe(true);

        await expect.poll(() => save.isDisabled()).toBe(true);
        await captureAgentFileScreenshot(page, "06-reset-uses-refreshed-authoritative-content.png");

        await gateway.deferNext("agents.files.get", { agentId: "main", name: "AGENTS.md" });
        await refresh.click();
        await expect
          .poll(async () => (await gateway.getRequests("agents.files.get")).length)
          .toBe(4);
        await editor.fill("Saved latest instructions");
        await gateway.setMethodResponse("agents.files.set", {
          ok: true,
          ...fileGet("main", "Saved latest instructions"),
        });
        await gateway.setMethodResponse(
          "agents.files.get",
          fileGetResponses("Saved latest instructions"),
        );
        await save.click();
        await expect.poll(() => save.isDisabled()).toBe(true);
        await gateway.resolveDeferred("agents.files.get", fileGet("main", "server revision 3"));
        await expect.poll(() => refresh.isEnabled()).toBe(true);
        await captureAgentFileScreenshot(page, "08-save-survives-older-refresh.png");
        await expect.poll(() => editor.inputValue()).toBe("Saved latest instructions");
        await expect.poll(() => reset.isDisabled()).toBe(true);

        const missingFile = { ...fileList("main").files[0], missing: true, content: "" };
        const missingList = { ...fileList("main"), files: [missingFile] };
        await gateway.setMethodResponse("agents.files.list", missingList);
        await gateway.setMethodResponse("agents.files.get", { ...missingList, file: missingFile });
        await refresh.click();
        await expect.poll(() => editor.inputValue()).toBe("");
        const missingHint = page.locator("#agent-file-panel .callout.info");
        await expect.poll(() => missingHint.isVisible()).toBe(true);
        await gateway.deferNext("agents.files.list", { agentId: "main" });
        const listsBeforeSave = (await gateway.getRequests("agents.files.list")).length;
        await refresh.click();
        await expect
          .poll(async () => (await gateway.getRequests("agents.files.list")).length)
          .toBe(listsBeforeSave + 1);
        await editor.fill("Saved latest instructions");
        await gateway.setMethodResponse(
          "agents.files.get",
          fileGetResponses("Saved latest instructions"),
        );
        await save.click();
        await expect.poll(() => missingHint.count()).toBe(0);
        await gateway.resolveDeferred("agents.files.list", missingList);
        await expect.poll(() => refresh.isEnabled()).toBe(true);
        await page.locator(".agents-refresh-btn").click();
        await expect.poll(() => page.locator(".agents-refresh-btn").isEnabled()).toBe(true);
        await expect.poll(() => editor.inputValue()).toBe("Saved latest instructions");
        expect(await missingHint.count()).toBe(0);
        await captureAgentFileScreenshot(page, "09-created-file-survives-stale-list.png");
      },
    );
  });
});
