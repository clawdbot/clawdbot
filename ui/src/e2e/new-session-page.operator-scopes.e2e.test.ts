import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

async function openDraft(
  operatorScopes: string[],
  featureMethods = ["chat.metadata", "chat.startup", "sessions.create", "sessions.dispatch"],
) {
  const context = await suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    featureMethods,
    operatorScopes,
    methodResponses: {
      "sessions.create": { key: "agent:main:operator-scope-proof", runStarted: true },
    },
  });
  await page.goto(`${suite.server.baseUrl}new`);
  await page.locator(".new-session-page__message").fill("scope proof");
  return { context, gateway, page };
}

suite.define(() => {
  it("keeps read-scoped operators out of new-session entry and submission paths", async () => {
    const { context, gateway, page } = await openDraft(["operator.read"]);
    try {
      const sidebarCreate = page.locator(".sidebar-brand__new-thread");
      const submit = page.getByRole("button", { name: "Start session" });
      const incognito = page.getByRole("switch", { name: "Incognito" });

      await expect.poll(() => sidebarCreate.isDisabled()).toBe(true);
      await expect.poll(() => submit.isDisabled()).toBe(true);
      await expect.poll(() => incognito.isDisabled()).toBe(true);
      expect(await incognito.getAttribute("title")).toBe(
        "This action requires operator.admin access.",
      );
      await submit.click({ force: true });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("allows write-scoped normal creation while keeping incognito admin-only", async () => {
    const { context, gateway, page } = await openDraft(["operator.read", "operator.write"]);
    try {
      const submit = page.getByRole("button", { name: "Start session" });
      const incognito = page.getByRole("switch", { name: "Incognito" });

      await expect.poll(() => page.locator(".sidebar-brand__new-thread").isEnabled()).toBe(true);
      await expect.poll(() => submit.isEnabled()).toBe(true);
      await expect.poll(() => incognito.isDisabled()).toBe(true);
      await submit.click();

      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { agentId: "main", message: "scope proof" },
      });
    } finally {
      await context.close();
    }
  });

  it("allows admin-scoped incognito creation with exact dynamic parameters", async () => {
    const { context, gateway, page } = await openDraft([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
    try {
      const incognito = page.getByRole("switch", { name: "Incognito" });
      await expect.poll(() => incognito.isEnabled()).toBe(true);
      await incognito.click();
      await page.getByRole("button", { name: "Start session" }).click();

      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { incognito: true, message: "scope proof" },
      });
    } finally {
      await context.close();
    }
  });

  it("blocks creation when the connected Gateway explicitly omits sessions.create", async () => {
    const { context, gateway, page } = await openDraft(
      ["operator.admin", "operator.read", "operator.write"],
      ["chat.metadata", "chat.startup"],
    );
    try {
      await expect.poll(() => page.locator(".sidebar-brand__new-thread").isDisabled()).toBe(true);
      const submit = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => submit.isDisabled()).toBe(true);
      await submit.click({ force: true });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("blocks creation while the Gateway is disconnected", async () => {
    const { context, gateway, page } = await openDraft([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
    try {
      await gateway.setOnline(false);
      await gateway.closeLatest(1001, "new-session scope proof");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: { context: { gateway: { snapshot: { phase: string } } } };
            };
            return app.runtime?.context.gateway.snapshot.phase;
          }),
        )
        .toBe("reconnecting");

      const submit = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => submit.isDisabled()).toBe(true);
      await submit.click({ force: true });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await gateway.setOnline(true);
      await context.close();
    }
  });
});
