/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { pt_BR } from "../../i18n/locales/pt-BR.ts";
import type { LogLevel } from "./log-lines.ts";
import { renderLogs } from "./view.ts";

type LogsProps = Parameters<typeof renderLogs>[0];

function createLevelFilters(overrides: Partial<Record<LogLevel, boolean>> = {}) {
  return {
    trace: true,
    debug: true,
    info: true,
    warn: true,
    error: true,
    fatal: true,
    ...overrides,
  };
}

function createProps(overrides: Partial<LogsProps> = {}): LogsProps {
  return {
    loading: false,
    status: { error: null, hasLoaded: false, stale: false },
    file: null,
    entries: [
      {
        raw: '{"level":"info","message":"matched line"}',
        time: "2026-06-14T12:00:00Z",
        level: "info",
        subsystem: "gateway",
        message: "matched line",
      },
    ],
    filterText: "",
    levelFilters: createLevelFilters(),
    autoFollow: true,
    truncated: false,
    onFilterTextChange: vi.fn(),
    onLevelToggle: vi.fn(),
    onToggleAutoFollow: vi.fn(),
    onRefresh: vi.fn(),
    onExport: vi.fn(),
    onScroll: vi.fn(),
    ...overrides,
  };
}

function buttonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${text} button`);
  }
  return button;
}

async function useTestPortugueseLogsLabels() {
  i18n.registerTranslation("pt-BR", {
    logsView: {
      title: "Registros",
      subtitle: "Registros do Gateway em JSONL.",
      exportButton: "Exportar {label}",
      exportLabels: {
        filtered: "filtrado",
        visible: "visivel",
      },
      filter: "Filtro",
      searchPlaceholder: "Pesquisar registros",
      autoFollow: "Acompanhar automaticamente",
      file: "Arquivo: {file}",
      truncated: "Saida truncada.",
      empty: "Nenhuma entrada.",
    },
  });
  await i18n.setLocale("pt-BR");
}

afterEach(async () => {
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale("en");
});

describe("renderLogs", () => {
  it("renders the subtitle under the section header", () => {
    const container = document.createElement("div");

    render(renderLogs(createProps()), container);

    expect(container.querySelector(".settings-section__desc")?.textContent?.trim()).toBe(
      "Gateway file logs (JSONL).",
    );
  });

  it.each([
    { buttonText: "Exportar visivel", expectedLabel: "visible", filterText: "" },
    { buttonText: "Exportar filtrado", expectedLabel: "filtered", filterText: "matched" },
  ])(
    "keeps the $expectedLabel export filename suffix stable when labels are localized",
    async ({ buttonText, expectedLabel, filterText }) => {
      await useTestPortugueseLogsLabels();
      const onExport = vi.fn();
      const container = document.createElement("div");

      render(renderLogs(createProps({ filterText, onExport })), container);
      buttonByText(container, buttonText).click();

      expect(onExport).toHaveBeenCalledWith(
        ['{"level":"info","message":"matched line"}'],
        expectedLabel,
      );
    },
  );

  it("renders a panel-local retry and stale marker without hiding loaded logs", () => {
    const onRefresh = vi.fn();
    const container = document.createElement("div");

    render(
      renderLogs(
        createProps({
          status: { error: "logs unavailable", hasLoaded: true, stale: true },
          onRefresh,
        }),
      ),
      container,
    );

    const status = container.querySelector(".logs-refresh-status");
    expect(status?.textContent).toContain("logs unavailable");
    expect(status?.textContent).toContain("Showing stale data");
    expect(container.textContent).toContain("matched line");
    status?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
