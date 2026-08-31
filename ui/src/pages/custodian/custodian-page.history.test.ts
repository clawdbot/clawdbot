/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

describe("custodian page history", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("shows advertised recent changes and loads a short cursor page inline", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "openclaw.chat") {
        return {
          sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
          reply: "Hello.",
          action: "none",
        };
      }
      if (method === "openclaw.changes.list" && !params.beforeCursor) {
        return {
          entries: [
            {
              id: "system-agent-audit:3",
              at: Date.now() - 5_000,
              kind: "operation",
              source: "system-agent",
              summary: "Set config gateway.port",
              changedPaths: ["gateway.port"],
            },
            {
              id: "config-audit:2",
              at: Date.now() - 10_000,
              kind: "external-edit",
              source: "external",
              summary: "Configuration edited outside OpenClaw",
              invalid: true,
              opaqueChange: true,
            },
            {
              id: "config-audit:0",
              at: Date.now() - 15_000,
              kind: "config-write",
              source: "plugin-install",
              summary: "Plugin installation updated configuration",
            },
          ],
          nextCursor: "next-page",
        };
      }
      if (method === "openclaw.changes.list" && params.beforeCursor === "next-page") {
        return {
          entries: [
            {
              id: "config-audit:1",
              at: Date.now() - 20_000,
              kind: "config-write",
              source: "config-rpc",
              summary: "Settings updated configuration: agents.defaults.model",
            },
          ],
        };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const harness = createContext(request, ["openclaw.chat", "openclaw.changes.list"]);
    const { context } = harness;
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.chat", expect.anything(), expect.anything()),
    );
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".custodian__history-toggle")!.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.changes.list", { limit: 50 }),
    );
    await page.updateComplete;

    expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(3);
    // A cursor, not a full page, controls continuation so bounded journal scans
    // can return fewer than 50 cards without hiding Load more.
    expect(page.querySelector(".custodian__history-more")).not.toBeNull();
    expect(page.querySelector(".custodian__change-source")?.textContent).toContain("system-agent");
    expect(page.querySelector(".custodian__change-paths")?.hasAttribute("open")).toBe(false);
    expect(page.querySelector(".custodian__change-card.is-invalid")?.textContent).toContain(
      "did not pass configuration validation",
    );
    expect(page.querySelector(".custodian__change-card.is-invalid")?.textContent).toContain(
      "Formatting or comments changed",
    );
    expect(
      Array.from(page.querySelectorAll(".custodian__change-source")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toContain("plugin install");

    page.querySelector<HTMLButtonElement>(".custodian__history-more")!.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("openclaw.changes.list", {
        limit: 50,
        beforeCursor: "next-page",
      }),
    );
    await page.updateComplete;
    expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(4);
    expect(page.querySelector(".custodian__history-more")).toBeNull();

    page.querySelector<HTMLButtonElement>(".custodian__history-toggle")!.click();
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__history-toggle")!.click();
    await waitForFast(() =>
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "openclaw.changes.list" && !params.beforeCursor,
        ),
      ).toHaveLength(2),
    );
    await page.updateComplete;
    expect(page.querySelectorAll(".custodian__change-card")).toHaveLength(3);

    harness.setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(page.querySelector(".custodian__history")).toBeNull());
    await page.updateComplete;
    expect(page.querySelector(".custodian__history")).toBeNull();
    expect(page.querySelector(".custodian__history-toggle")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("hides change history when the gateway does not advertise it", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Hello.",
      action: "none",
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    expect(page.querySelector(".custodian__history-toggle")).toBeNull();
  });
});
