/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { pt_BR } from "../../../i18n/locales/pt-BR.ts";
import { renderWorkspaceConflictNotice } from "./chat-workspace-conflict.ts";

const conflict = {
  paths: ["src/local.ts"],
  stagedResultRef: "refs/openclaw/worker-results/claim-test",
};

afterEach(async () => {
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale("en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "execCommand");
  document.body.replaceChildren();
});

describe("workspace conflict copy actions", () => {
  it("renders the compact summary and command disclosure from the active locale", async () => {
    i18n.registerTranslation("pt-BR", {
      chat: {
        workspaceConflict: {
          titleOne: "1 conflito de workspace na nuvem",
          summary: "Versoes locais mantidas.",
          showCommands: "Mostrar comandos",
          inspectCloud: "Inspecionar versao da nuvem",
          takeCloud: "Usar versao da nuvem",
          stagedResult: "Resultado preparado",
          copyStagedResult: "Copiar referencia",
          copyInspectCommand: "Copiar comando de inspecao",
          copyTakeCommand: "Copiar comando da nuvem",
          commandHelp: "Execute estes comandos.",
        },
      },
    });
    await i18n.setLocale("pt-BR");
    const container = document.body.appendChild(document.createElement("div"));

    render(renderWorkspaceConflictNotice({ conflict }), container);

    expect(container.querySelector(".chat-composer-neighbor-card__copy")?.textContent).toContain(
      "Versoes locais mantidas.",
    );
    expect(
      container.querySelector(".chat-workspace-conflict-commands-disclosure summary")?.textContent,
    ).toBe("Mostrar comandos");
  });

  it.each([
    { copied: true, expected: "Copied!" },
    { copied: false, expected: "Copy failed" },
  ])("shows visible feedback when clipboard success is $copied", async ({ copied, expected }) => {
    const writeText = copied
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    const container = document.body.appendChild(document.createElement("div"));
    render(renderWorkspaceConflictNotice({ conflict }), container);

    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.includes("Inspect the first cloud version"),
    );
    button?.click();

    await vi.waitFor(() => expect(button?.textContent?.trim()).toBe(expected));
    expect(button?.getAttribute("aria-label")).toBe(expected);
    expect(writeText).toHaveBeenCalledWith(
      "git show 'refs/openclaw/worker-results/claim-test:src/local.ts'",
    );
  });
});
