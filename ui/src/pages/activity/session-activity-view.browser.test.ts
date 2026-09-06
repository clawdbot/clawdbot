import { render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { SessionActivityController } from "./session-activity-controller.ts";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../styles/settings.css";
import "../../styles/settings-controls.css";
import "../../styles/activity.css";
import { renderSessionActivityView } from "./session-activity-view.ts";

let container: HTMLDivElement;

beforeEach(() => {
  // Own the Lit root: other browser suites may replace the shared body children.
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(null, container);
  container.remove();
});

it.each([
  { personId: null, width: 900 },
  { personId: "person", width: 900 },
  { personId: null, width: 390 },
  { personId: "person", width: 390 },
])(
  "keeps content stable through passive refresh and explicit Retry ($personId, $width px)",
  async ({ personId, width }) => {
    await page.viewport(width, 700);
    const props: Parameters<typeof renderSessionActivityView>[0] = {
      context: {
        basePath: "",
        navigate: vi.fn(),
        gateway: { snapshot: { hello: null } },
        agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
        agentSelection: { state: { selectedId: "main" } },
        sessions: { state: { result: { sessions: [] } } },
      } as unknown as ApplicationContext,
      filters: { personId, query: "", time: "7d" },
      presenceViewers: [],
      loading: false,
      retrying: false,
      result: {
        ts: 1,
        path: "",
        count: 0,
        sessions: [],
        defaults: { model: null, modelProvider: null, contextTokens: null },
        people: [{ identity: { type: "profile", id: "person" }, label: "Person", sessionCount: 0 }],
      },
      expandedAutomationDays: new Set(),
      onRetry: vi.fn(),
      onAutomationDayToggle: vi.fn(),
      onFiltersChange: vi.fn(),
    };
    render(renderSessionActivityView(props), container);
    const main = container.querySelector<HTMLElement>(".activity-feed__main")!;
    const content = main.querySelector<HTMLElement>(
      personId ? "[data-activity-identity]" : ".activity-feed__summary",
    )!;
    expect(getComputedStyle(container.querySelector(".activity-feed__feedback")!).minHeight).toBe(
      "32px",
    );
    const top = content.getBoundingClientRect().top;
    expect(content.getBoundingClientRect().height).toBeGreaterThan(0);

    for (const loading of [true, false, true, false]) {
      render(renderSessionActivityView({ ...props, loading }), container);
      expect(Math.abs(content.getBoundingClientRect().top - top)).toBeLessThan(1);
      expect(main.textContent).not.toContain("Loading");
    }

    const request = vi.fn().mockResolvedValue(props.result);
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new SessionActivityController({
      addController() {},
      removeController() {},
      updateComplete: Promise.resolve(true),
      requestUpdate: () =>
        render(
          renderSessionActivityView({
            ...props,
            result: controller.result,
            error: controller.error,
            loading: controller.loading,
            retrying: controller.retrying,
            onRetry: () => controller.load(client, props.filters, "retry"),
          }),
          container,
        ),
    });
    try {
      controller.load(client, props.filters);
      await vi.waitFor(() => expect(controller.loading).toBe(false));
      const retained = container.querySelector<HTMLElement>(
        personId ? "[data-activity-identity]" : ".activity-feed__summary",
      )!;
      const retainedTop = retained.getBoundingClientRect().top;
      request.mockRejectedValueOnce(new Error("Refresh failed"));
      controller.load(client, props.filters, "refresh");
      await vi.waitFor(() => expect(controller.error).toBe("Refresh failed"));
      expect(Math.abs(retained.getBoundingClientRect().top - retainedTop)).toBeLessThan(1);
      const retryButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Retry",
      )!;
      expect(retryButton).toBeTruthy();
      const pending = createDeferred<NonNullable<typeof props.result>>();
      request.mockReturnValueOnce(pending.promise);
      retryButton.click();
      expect(controller.loading).toBe(true);
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Refreshing");
      expect(retryButton.disabled).toBe(true);
      expect(Math.abs(retained.getBoundingClientRect().top - retainedTop)).toBeLessThan(1);
      pending.reject(new Error("Retry failed"));
      await vi.waitFor(() => expect(controller.error).toBe("Retry failed"));
      expect(retryButton.disabled).toBe(false);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Retry failed");
      expect(Math.abs(retained.getBoundingClientRect().top - retainedTop)).toBeLessThan(1);
      const recovered = createDeferred<NonNullable<typeof props.result>>();
      request.mockReturnValueOnce(recovered.promise);
      retryButton.click();
      expect(controller.retrying).toBe(true);
      expect(retryButton.disabled).toBe(true);
      recovered.resolve(props.result!);
      await vi.waitFor(() => expect(controller.loading).toBe(false));
      expect(container.textContent).not.toContain("Refreshing");
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(Math.abs(retained.getBoundingClientRect().top - retainedTop)).toBeLessThan(1);
    } finally {
      controller.hostDisconnected();
    }

    render(renderSessionActivityView({ ...props, result: undefined, loading: true }), container);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading");
  },
);
