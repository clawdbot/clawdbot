import assert from "node:assert/strict";
import path from "node:path";
import type { Browser } from "playwright";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { waitForHotReloadFact } from "./gateway-config-hot-reload-fixtures.js";

export async function proveHotReloadBrowserSettings({
  browser,
  gateway,
  outputDir,
  fixture,
  rpc,
  patch,
  turn,
  verifyContinuity,
  http,
}: {
  browser: Browser;
  gateway: QaGatewayChild;
  outputDir: string;
  fixture: { baseUrl: string; readonly faviconRequests: number };
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  patch: (change: unknown) => Promise<unknown>;
  turn: (message: string, sessionKey?: string) => Promise<string>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
  http: (route: string) => Promise<{ status: number }>;
}) {
  const SESSION_KEY = "agent:qa:main";
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  await context.addInitScript(
    ({ gatewayUrl, token }) => {
      Object.assign(window, { __OPENCLAW_NATIVE_CONTROL_AUTH__: { gatewayUrl, token } });
    },
    { gatewayUrl: gateway.wsUrl, token: gateway.token },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const refreshPage = async () => {
    await page.goto(`${gateway.baseUrl}/chat/qa`);
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
  };
  for (const environment of [
    { label: "Reload A", color: "teal" },
    { label: "Reload B", color: "amber" },
  ]) {
    await patch({ gateway: { controlUi: { environment } } });
    await refreshPage();
    await page.waitForFunction(
      (label) => document.title.endsWith(` · ${label}`),
      environment.label,
    );
    assert.equal(await page.locator(".control-ui-environment-stripe").count(), 1);
    await page.screenshot({ path: path.join(outputDir, `environment-${environment.color}.png`) });
  }
  await verifyContinuity(
    "gateway.controlUi.environment",
    "Reloaded real Control UI showed the new title suffix and environment stripe",
  );
  await turn("Reply exactly `UI_FIXTURE_READY`");
  await rpc("chat.inject", {
    sessionKey: SESSION_KEY,
    agentId: "qa",
    message: `[embed url="${fixture.baseUrl}/widget" title="Reload widget" /]\nRead [fixture docs](https://example.com/guide).`,
  });
  for (const allowed of [false, true, false]) {
    await patch({ gateway: { controlUi: { allowExternalEmbedUrls: allowed } } });
    await refreshPage();
    await page.getByText("fixture docs", { exact: true }).waitFor();
    const frame = page.locator(`iframe[src^="${fixture.baseUrl}/widget"]`);
    await waitForHotReloadFact("external embed policy", async () =>
      (await frame.count()) === (allowed ? 1 : 0) ? true : undefined,
    );
  }
  await verifyContinuity(
    "gateway.controlUi.allowExternalEmbedUrls",
    "The same persisted assistant embed disappeared, loaded, then disappeared after real page reloads",
  );
  await patch({ gateway: { controlUi: { allowExternalEmbedUrls: true } } });
  for (const mode of ["strict", "scripts", "trusted"] as const) {
    await patch({ gateway: { controlUi: { embedSandbox: mode } } });
    await refreshPage();
    const frame = page.locator(`iframe[src^="${fixture.baseUrl}/widget"]`);
    await frame.waitFor();
    const sandbox = await frame.getAttribute("sandbox");
    assert.equal(sandbox?.includes("allow-scripts") ?? false, mode !== "strict");
    assert.equal(sandbox?.includes("allow-same-origin") ?? false, mode === "trusted");
    if (mode !== "strict") {
      await frame.contentFrame().locator('body[data-script-ran="yes"]').waitFor();
    } else {
      await frame.contentFrame().locator("#proof").waitFor();
      assert.equal(
        await frame.contentFrame().locator("body").getAttribute("data-script-ran"),
        null,
      );
    }
    await page.screenshot({ path: path.join(outputDir, `embed-${mode}.png`) });
  }
  await verifyContinuity(
    "gateway.controlUi.embedSandbox",
    "Real iframe sandbox attributes changed; scripts executed only in enabled modes",
  );
  for (const enabled of [false, true, false]) {
    await patch({ gateway: { controlUi: { automaticallyFetchFavicons: enabled } } });
    const response = await http("/__openclaw__/link-favicon/example.com");
    assert.equal(response.status, enabled ? 200 : 404);
    await refreshPage();
    await page.getByText("fixture docs", { exact: true }).waitFor();
    const icon = page.locator('img.markdown-link-favicon[data-link-favicon-host="example.com"]');
    if (enabled) {
      await waitForHotReloadFact("loaded favicon", async () =>
        (await icon.getAttribute("class"))?.includes("is-loaded") ? true : undefined,
      );
    } else {
      assert.equal(await icon.count(), 0);
    }
  }
  assert(fixture.faviconRequests > 0);
  await verifyContinuity(
    "gateway.controlUi.automaticallyFetchFavicons",
    "Real authenticated favicon HTTP and rendered icon respected opt-out and re-enable",
  );

  await context.close();
}
