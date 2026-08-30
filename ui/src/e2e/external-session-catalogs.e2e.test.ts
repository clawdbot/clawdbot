import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "OpenCode and Pi external session catalogs",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "beam",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const;

suite.define(() => {
  it.each(["sidebar", "cold link"])(
    "preserves catalog pane ownership from %s through retention, split focus, reconnect and adoption",
    async (entrance) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const source = {
          catalogId: "fixture-catalog",
          hostId: "node:DevBox",
          threadId: "Thread:A/B",
        };
        const search = `?${new URLSearchParams({ catalog: source.catalogId, host: source.hostId, thread: source.threadId })}`;
        const owners = ["main", "other"];
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.6-luna",
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "sessions.catalog.list",
            "sessions.catalog.read",
            "sessions.catalog.continue",
          ],
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
              agents: owners.map((id) => ({ id, name: id === "main" ? "Main" : "Other" })),
            },
            "agent.identity.get": {
              cases: owners.map((agentId) => ({
                match: { agentId },
                response: { agentId, name: agentId === "main" ? "Main" : "Other", avatar: "" },
              })),
            },
            "sessions.catalog.list": {
              cases: owners.map((agentId) => ({
                match: { agentId },
                response: {
                  catalogs: [
                    {
                      id: source.catalogId,
                      label: "Native fixture",
                      capabilities: { continueSession: true, archive: false },
                      hosts: [
                        {
                          hostId: source.hostId,
                          label: "Dev Box",
                          kind: "node",
                          connected: true,
                          sessions: [
                            {
                              threadId: source.threadId,
                              name: `${agentId} native thread`,
                              status: "stored",
                              canContinue: true,
                              canArchive: false,
                              sourceHomeId: `${agentId}-home`,
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              })),
            },
            "sessions.catalog.read": {
              cases: owners.map((agentId) => ({
                match: { ...source, agentId, sourceHomeId: `${agentId}-home` },
                response: {
                  ...source,
                  items: [{ type: "agentMessage", text: `${agentId} native transcript` }],
                },
              })),
            },
            "sessions.catalog.continue": {
              cases: owners.map((agentId) => ({
                match: { ...source, agentId, sourceHomeId: `${agentId}-home` },
                response: { sessionKey: `agent:${agentId}:adopted-native` },
              })),
            },
          },
        });
        const activePane = page.locator(
          "openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])",
        );
        const composer = () => activePane.locator(".agent-chat__composer-combobox > textarea");
        const navigate = async (agentId: string, catalog = true) => {
          await page.evaluate(
            ({ agentId: routeAgentId, search: routeSearch }) => {
              const app = document.querySelector("openclaw-app") as HTMLElement & {
                runtime: { context: ApplicationContext };
              };
              app.runtime.context.navigate("chat", {
                pathname: `/chat/${routeAgentId}`,
                search: routeSearch,
              });
            },
            { agentId, search: catalog ? search : "" },
          );
          await waitForControlUiRoute(page, {
            routeId: "chat",
            pathname: `/chat/${agentId}`,
            search: catalog ? search : "",
          });
        };
        const assertOwner = async (agentId: string) => {
          await expect
            .poll(() =>
              page.evaluate(() => {
                const app = document.querySelector("openclaw-app") as HTMLElement & {
                  runtime: { context: ApplicationContext };
                };
                return app.runtime.context.agentSelection.state.selectedId;
              }),
            )
            .toBe(agentId);
          await expect
            .poll(() =>
              activePane.evaluateAll((panes) =>
                panes.map((pane) => {
                  const chat = pane as HTMLElement & {
                    active: boolean;
                    presented: boolean;
                    state: { assistantAgentId: string };
                  };
                  return {
                    active: chat.active,
                    presented: chat.presented,
                    owner: chat.state.assistantAgentId,
                  };
                }),
              ),
            )
            .toEqual([{ active: true, presented: true, owner: agentId }]);
        };

        await page.goto(
          `${suite.server.baseUrl}chat/${entrance === "cold link" ? `other${search}` : "main"}`,
        );
        const sidebar = page.locator("openclaw-app-sidebar");
        if (entrance === "sidebar") {
          await sidebar.getByRole("button", { name: /Switch agent/ }).click();
          await sidebar
            .locator("wa-dropdown.sidebar-agent-menu")
            .getByRole("menuitemradio", { name: "Other", exact: true })
            .click();
          await waitForControlUiRoute(page, {
            routeId: "chat",
            pathname: "/chat/other",
            search: "",
          });
          await assertOwner("other");
          await sidebar.getByText("other native thread", { exact: true }).click();
        }
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/other", search });
        expect((await gateway.waitForRequest("sessions.catalog.read")).params).toMatchObject({
          ...source,
          agentId: "other",
          sourceHomeId: "other-home",
        });
        await activePane.getByText("other native transcript", { exact: true }).waitFor();
        await assertOwner("other");
        await expect
          .poll(() =>
            sidebar
              .locator('[data-session-section="catalog:fixture-catalog"] a[aria-current="page"]')
              .textContent(),
          )
          .toContain("other native thread");
        await composer().fill("other retained draft");

        // Same source, different route owner: no intervening ordinary session may hide a key collision.
        await navigate("main");
        await activePane.getByText("main native transcript", { exact: true }).waitFor();
        await assertOwner("main");
        expect(await composer().inputValue()).toBe("");
        await composer().fill("main retained draft");
        await navigate("other");
        await assertOwner("other");
        expect(await composer().inputValue()).toBe("other retained draft");
        expect(
          await page
            .locator("openclaw-chat-pane")
            .filter({ hasText: "main native transcript" })
            .count(),
        ).toBe(1);
        const readsBeforeReturn = (await gateway.getRequests("sessions.catalog.read")).length;
        await navigate("other", false);
        await sidebar.getByText("other native thread", { exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/other", search });
        await assertOwner("other");
        expect(await composer().inputValue()).toBe("other retained draft");
        expect(await gateway.getRequests("sessions.catalog.read")).toHaveLength(readsBeforeReturn);

        await activePane.getByRole("button", { name: "Open split view" }).click();
        await navigate("main");
        const visiblePanes = page.locator(
          "openclaw-chat-pane.chat-pane-cache__pane--visible:not([inert])",
        );
        await expect.poll(() => visiblePanes.count()).toBe(2);
        await visiblePanes.getByText("other native transcript", { exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/other", search });
        await assertOwner("other");
        await visiblePanes.getByText("main native transcript", { exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/main", search });
        await assertOwner("main");

        // Ordinary Gateway publication and transport reconnect must retain each pane's owner.
        const instanceId = await page.evaluate(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: { context: ApplicationContext };
          };
          return app.runtime.context.gateway.snapshot.client?.instanceId;
        });
        await gateway.emitGatewayEvent("presence", {
          presence: [{ instanceId, user: { id: "fixture-user", name: "Fixture User" } }],
        });
        await expect
          .poll(() =>
            visiblePanes.evaluateAll((panes) =>
              panes.map((pane) => {
                const chat = pane as HTMLElement & {
                  state: { selfUser: { id: string } | null; assistantAgentId: string };
                };
                return [chat.state.selfUser?.id, chat.state.assistantAgentId];
              }),
            ),
          )
          .toEqual([
            ["fixture-user", "other"],
            ["fixture-user", "main"],
          ]);
        await assertOwner("main");
        await gateway.closeLatest();
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(1);
        await expect
          .poll(() =>
            visiblePanes.evaluateAll((panes) =>
              panes.map((pane) => {
                const chat = pane as HTMLElement & {
                  state: { connected: boolean; assistantAgentId: string };
                };
                return [chat.state.connected, chat.state.assistantAgentId];
              }),
            ),
          )
          .toEqual([
            [true, "other"],
            [true, "main"],
          ]);
        await visiblePanes.getByText("other native transcript", { exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/other", search });
        await assertOwner("other");
        await composer().fill("Continue under Other");
        await activePane.getByRole("button", { name: "Send message", exact: true }).click();
        expect((await gateway.waitForRequest("sessions.catalog.continue")).params).toMatchObject({
          ...source,
          agentId: "other",
          sourceHomeId: "other-home",
        });
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({
          sessionKey: "agent:other:adopted-native",
          message: "Continue under Other",
        });
        await waitForControlUiRoute(page, {
          routeId: "chat",
          pathname: "/chat/other/adopted-native",
          search: "",
        });
        await assertOwner("other");
        await gateway.emitChatFinal({
          runId: (sent.params as { idempotencyKey: string }).idempotencyKey,
          sessionKey: "agent:other:adopted-native",
          text: "Other continuation completed",
        });
        await activePane
          .locator("p")
          .getByText("Other continuation completed", { exact: true })
          .waitFor();
        const adoptedRow = sidebar.locator('[data-session-key="agent:other:adopted-native"]');
        await navigate("other", false);
        await adoptedRow.locator("a").click();
        await waitForControlUiRoute(page, {
          routeId: "chat",
          pathname: "/chat/other/adopted-native",
          search: "",
        });
        await assertOwner("other");
        for (const request of await gateway.getRequests("sessions.catalog.read")) {
          expect(request.params).toMatchObject(source);
          const params = request.params as { agentId: string; sourceHomeId: string };
          expect(params.sourceHomeId).toBe(`${params.agentId}-home`);
        }
      });
    },
  );

  it("keeps old Beam links working and opens pretty shares under a non-main default agent", async () => {
    const artifactDir = path.resolve(".artifacts/control-ui-e2e/beam-share-url");
    await fs.mkdir(artifactDir, { recursive: true });
    const context = await suite.newBrowserContext({
      recordVideo: { dir: artifactDir, size: { width: 1280, height: 720 } },
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    const fullId = "0123456789abcdef0123456789abcdef";
    const prettyPath = "/openclaw/beam/0123456789ab";
    const queryPath = `/openclaw/chat/research?catalog=beam&host=gateway&thread=${fullId}`;
    const gateway = await installMockGateway(page, {
      basePath: "/openclaw",
      defaultAgentId: "research",
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.catalog.list",
        "sessions.catalog.read",
      ],
      methodResponses: {
        // Beam rows live in the plugin catalog, not the native session store.
        "sessions.describe": { session: null },
        "agents.list": {
          agents: [
            { id: "research", name: "Research" },
            { id: "other", name: "Other" },
          ],
          defaultId: "research",
          mainKey: "main",
        },
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "beam",
              label: "Beam",
              capabilities: { continueSession: false, archive: false },
              shareRoute: SHARE_ROUTE,
              hosts: [
                {
                  hostId: "gateway",
                  label: "Beamed sessions",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: fullId,
                      name: "Pretty Beam route",
                      status: "live",
                      archived: false,
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
        "sessions.catalog.read": {
          hostId: "gateway",
          label: "Pretty Beam route",
          threadId: fullId,
          items: [
            { type: "userMessage", text: "Keep this Beam URL readable." },
            { type: "agentMessage", text: "The pretty route stayed put." },
          ],
        },
      },
    });

    const assertCatalogOwner = async (agentId = "research") => {
      await expect
        .poll(() =>
          page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible").evaluateAll((panes) =>
            panes.map((pane) => {
              const chat = pane as HTMLElement & {
                sessionKey: string;
                state: { assistantAgentId: string };
              };
              return { sessionKey: chat.sessionKey, agentId: chat.state.assistantAgentId };
            }),
          ),
        )
        .toEqual([{ sessionKey: `agent:${agentId}:catalog:beam:gateway:${fullId}`, agentId }]);
    };

    try {
      const queryResponse = await page.goto(new URL(queryPath, suite.server.baseUrl).href);
      expect(queryResponse?.status()).toBe(200);
      const transcript = page.getByText("The pretty route stayed put.", { exact: true });
      await transcript.waitFor();
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(queryPath);
      await assertCatalogOwner();
      await page.screenshot({
        path: path.join(artifactDir, "beam-query-route.png"),
        fullPage: true,
      });

      const response = await page.goto(new URL(prettyPath, suite.server.baseUrl).href);
      expect(response?.status()).toBe(200);
      await transcript.waitFor();
      await assertCatalogOwner();
      expect(new URL(page.url()).pathname).toBe(prettyPath);
      expect(new URL(page.url()).search).toBe("");
      await page
        .locator(".sidebar-recent-session--active", { hasText: "Pretty Beam route" })
        .waitFor();
      await page
        .locator(".chat-pane__session-title-text", { hasText: "Pretty Beam route" })
        .waitFor();
      expect(
        await page
          .locator("openclaw-chat-pane.chat-pane-cache__pane--visible textarea")
          .isDisabled(),
      ).toBe(true);
      const resolution = (await gateway.getRequests("sessions.catalog.list")).find(
        (request) => (request.params as { search?: string } | undefined)?.search,
      );
      expect(resolution?.params).toEqual({
        agentId: "research",
        search: "0123456789ab",
        limitPerHost: 2,
      });
      expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
        agentId: "research",
        catalogId: "beam",
        hostId: "gateway",
        threadId: fullId,
      });

      await page.reload();
      await page.getByText("The pretty route stayed put.", { exact: true }).waitFor();
      await assertCatalogOwner();
      expect(new URL(page.url()).pathname).toBe(prettyPath);
      expect(new URL(page.url()).search).toBe("");

      await page.screenshot({
        path: path.join(artifactDir, "beam-pretty-route.png"),
        fullPage: true,
      });

      await page.goto(new URL("/openclaw/chat/other", suite.server.baseUrl).href);
      const beamRow = page.locator("a", { hasText: "Pretty Beam route" }).first();
      await beamRow.waitFor();
      await beamRow.click();
      await page.getByText("The pretty route stayed put.", { exact: true }).waitFor();
      await assertCatalogOwner("other");
      expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
        `/openclaw/chat/other?catalog=beam&host=gateway&thread=${fullId}`,
      );
      expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
        agentId: "other",
        catalogId: "beam",
        threadId: fullId,
      });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("shows both paired-node catalogs and opens their view-only transcripts", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1440, height: 900 } });
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.catalog.list",
        "sessions.catalog.read",
      ],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "opencode",
              label: "OpenCode",
              capabilities: { continueSession: false, archive: false },
              hosts: [
                {
                  hostId: "node:devbox",
                  label: "Dev Box",
                  kind: "node",
                  connected: true,
                  nodeId: "devbox",
                  sessions: [
                    {
                      threadId: "opencode-1",
                      name: "OpenCode release review",
                      status: "stored",
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
            {
              id: "pi",
              label: "Pi",
              capabilities: { continueSession: false, archive: false },
              hosts: [
                {
                  hostId: "node:devbox",
                  label: "Dev Box",
                  kind: "node",
                  connected: true,
                  nodeId: "devbox",
                  sessions: [
                    {
                      threadId: "pi-1",
                      name: "Pi architecture notes",
                      status: "stored",
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
        "sessions.catalog.read": {
          cases: [
            {
              match: { catalogId: "opencode", threadId: "opencode-1" },
              response: {
                hostId: "node:devbox",
                threadId: "opencode-1",
                items: [{ type: "agentMessage", text: "OpenCode transcript loaded" }],
              },
            },
            {
              match: { catalogId: "pi", threadId: "pi-1" },
              response: {
                hostId: "node:devbox",
                threadId: "pi-1",
                items: [{ type: "agentMessage", text: "Pi transcript loaded" }],
              },
            },
          ],
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await expect
      .poll(() =>
        page
          .locator('[data-session-section="catalog:opencode"] [data-provider-icon="opencode"]')
          .count(),
      )
      .toBe(1);
    await expect
      .poll(() =>
        page.locator('[data-session-section="catalog:pi"] [data-provider-icon="pi"]').count(),
      )
      .toBe(1);
    const piIconResponse = await page.request.get(
      new URL("provider-icons/ProviderIcon-pi.svg", suite.server.baseUrl).toString(),
    );
    expect(piIconResponse.ok()).toBe(true);

    await page.getByText("OpenCode release review", { exact: true }).click();
    await expect.poll(() => page.getByText("OpenCode transcript loaded").count()).toBe(1);
    await page.getByText("Pi architecture notes", { exact: true }).click();
    const piPane = page
      .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
      .filter({ hasText: "Pi transcript loaded" });
    await piPane.getByText("Pi transcript loaded").waitFor();
    expect(await piPane.locator(".agent-chat__composer-combobox > textarea").isDisabled()).toBe(
      true,
    );
    expect(await gateway.getRequests("sessions.catalog.read")).toHaveLength(2);

    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await fs.mkdir(artifactDir, { recursive: true });
      await page.screenshot({
        path: path.join(artifactDir, "external-session-catalogs.png"),
        fullPage: true,
      });
    }
    await page.close();
  });
});
