import { render } from "lit";
import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { renderRunsSection } from "./view-runs.ts";

type CronRunsSectionProps = Parameters<typeof renderRunsSection>[0];

function createRunsProps(overrides: Partial<CronRunsSectionProps> = {}): CronRunsSectionProps {
  return {
    basePath: "",
    agentId: "main",
    runs: [],
    runsHasMore: false,
    runsLoadingMore: false,
    runsStatuses: [],
    runsDeliveryStatuses: [],
    runsQuery: "",
    runsSortDir: "desc",
    onLoadMoreRuns: () => undefined,
    onRunsFiltersChange: () => undefined,
    ...overrides,
  };
}

function renderRuns(overrides: Partial<CronRunsSectionProps> = {}) {
  const container = document.createElement("div");
  render(renderRunsSection(createRunsProps(overrides)), container);
  return container;
}

function getFilterTrigger(container: Element, filter: "status" | "delivery") {
  const trigger = container.querySelector<HTMLButtonElement>(
    `[data-filter="${filter}"] .cron-filter-dropdown__trigger`,
  );
  expect(trigger).toBeInstanceOf(HTMLButtonElement);
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${filter} filter trigger`);
  }
  return trigger;
}

describe("cron run filter accessibility", () => {
  it("includes active selections in run filter accessible names", () => {
    const allRuns = renderRuns();
    expect(getFilterTrigger(allRuns, "status").getAttribute("aria-label")).toBe(
      "Status All statuses",
    );
    expect(getFilterTrigger(allRuns, "delivery").getAttribute("aria-label")).toBe(
      "Delivery All delivery",
    );

    const singlyFilteredRuns = renderRuns({
      runsStatuses: ["error"],
      runsDeliveryStatuses: ["delivered"],
    });
    expect(getFilterTrigger(singlyFilteredRuns, "status").getAttribute("aria-label")).toBe(
      "Status Error",
    );
    expect(getFilterTrigger(singlyFilteredRuns, "delivery").getAttribute("aria-label")).toBe(
      "Delivery Delivered",
    );

    const doublyFilteredRuns = renderRuns({
      runsStatuses: ["error", "ok"],
      runsDeliveryStatuses: ["not-delivered", "delivered"],
    });
    const doublyFilteredStatus = getFilterTrigger(doublyFilteredRuns, "status");
    const doublyFilteredDelivery = getFilterTrigger(doublyFilteredRuns, "delivery");
    expect(doublyFilteredStatus.getAttribute("aria-label")).toBe("Status OK, Error");
    expect(doublyFilteredDelivery.getAttribute("aria-label")).toBe(
      "Delivery Delivered, Not delivered",
    );
    expect(doublyFilteredStatus.textContent).toContain("OK, Error");
    expect(doublyFilteredDelivery.textContent).toContain("Delivered, Not delivered");

    const filteredRuns = renderRuns({
      runsStatuses: ["error", "ok", "skipped"],
      runsDeliveryStatuses: ["delivered", "not-delivered", "unknown"],
    });
    const statusTrigger = getFilterTrigger(filteredRuns, "status");
    const deliveryTrigger = getFilterTrigger(filteredRuns, "delivery");
    expect(statusTrigger.getAttribute("aria-label")).toBe("Status OK +2 (OK, Error, and Skipped)");
    expect(deliveryTrigger.getAttribute("aria-label")).toBe(
      "Delivery Delivered +2 (Delivered, Not delivered, and Unknown)",
    );
    expect(statusTrigger.textContent).toContain("OK +2");
    expect(deliveryTrigger.textContent).toContain("Delivered +2");
  });

  it("formats translated filter selections using the active app locale", async () => {
    const restoreI18nState = captureI18nStateForTesting();
    try {
      await i18n.setLocale("de");
      const doublyFilteredRuns = renderRuns({
        runsStatuses: ["error", "ok"],
        runsDeliveryStatuses: ["not-delivered", "delivered"],
      });
      const doublyFilteredStatus = getFilterTrigger(doublyFilteredRuns, "status");
      const doublyFilteredDelivery = getFilterTrigger(doublyFilteredRuns, "delivery");
      expect(doublyFilteredStatus.getAttribute("aria-label")).toBe("Status OK, Fehler");
      expect(doublyFilteredDelivery.getAttribute("aria-label")).toBe(
        "Zustellung Zugestellt, Nicht zugestellt",
      );
      expect(doublyFilteredStatus.textContent).toContain("OK, Fehler");
      expect(doublyFilteredDelivery.textContent).toContain("Zugestellt, Nicht zugestellt");

      const container = renderRuns({
        runsStatuses: ["ok", "error", "skipped"],
        runsDeliveryStatuses: ["delivered", "not-delivered", "unknown"],
      });
      expect(getFilterTrigger(container, "status").getAttribute("aria-label")).toBe(
        "Status OK +2 (OK, Fehler und Übersprungen)",
      );
      expect(getFilterTrigger(container, "delivery").getAttribute("aria-label")).toBe(
        "Zustellung Zugestellt +2 (Zugestellt, Nicht zugestellt und Unbekannt)",
      );
    } finally {
      await restoreI18nState();
    }
  });

  it("restores shared system-locale mode after a temporary explicit selection", async () => {
    const restoreOriginalState = captureI18nStateForTesting();
    try {
      await i18n.useSystemLocale();
      const systemLocale = i18n.getLocale();
      expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();

      const restoreSystemState = captureI18nStateForTesting();
      await i18n.setLocale("de");
      expect(localStorage.getItem("openclaw.i18n.locale")).toBe("de");

      await restoreSystemState();
      expect(i18n.getLocale()).toBe(systemLocale);
      expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
    } finally {
      await restoreOriginalState();
    }
  });

  it("creates selected run filter markup without a browser document", () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    expect(documentDescriptor).toBeDefined();
    if (!documentDescriptor) {
      throw new Error("Expected a restorable document descriptor");
    }

    try {
      Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
      expect(() =>
        renderRunsSection(createRunsProps({ runsStatuses: ["ok", "error", "skipped"] })),
      ).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "document", documentDescriptor);
    }
  });
});
