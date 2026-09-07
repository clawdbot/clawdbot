/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderToolCard, resolveToolRowText } from "./chat-tool-cards.ts";

describe("execution purpose cards", () => {
  it.each([
    { name: "exec", args: { code: "await tools.read({ path: 'README.md' })" } },
    { name: "exec", args: { command: "set -euo pipefail\npnpm test" } },
    {
      name: "exec",
      args: { command: "pnpm test", code: "await tools.read({ path: 'README.md' })" },
    },
    { name: "bash", args: { command: "pnpm test" } },
    { name: "shell", args: { command: "pnpm test" } },
  ])(
    "shows the agent purpose immediately for $name and retains execution details",
    ({ name, args }) => {
      const container = document.createElement("div");
      const card = {
        id: "msg:purpose",
        name,
        args: { ...args, title: "Check the workspace" },
        live: true,
        outputText: "workspace checked",
      };
      const options = {
        messageKey: "purpose",
        expanded: false,
        runActive: true,
        onToggleExpanded: vi.fn(),
      };
      render(renderToolCard(card, options), container);
      expect(container.querySelector(".chat-tool-row__title")?.textContent).toBe(
        "Check the workspace",
      );
      expect(container.querySelector(".chat-tool-row__cmd")).toBeNull();
      expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
      expect(resolveToolRowText(card, true)).toBe("Check the workspace");

      render(
        renderToolCard({ ...card, completed: true }, { ...options, expanded: true }),
        container,
      );
      expect(container.querySelector(".chat-tool-row__title")?.textContent).toBe(
        "Check the workspace",
      );
      for (const source of Object.values(args)) {
        expect(container.querySelector(".chat-tool-msg-body")?.textContent).toContain(source);
      }
      if (args.code) {
        expect(container.querySelector(".chat-tool-term")).toBeNull();
      }
      expect(container.querySelector(".chat-tool-msg-body")?.textContent).toContain(
        "workspace checked",
      );
    },
  );

  it.each([
    { name: "calendar_create", args: { title: "Team meeting", command: "create" } },
    { name: "document_create", args: { title: "Design notes", content: "Draft" } },
  ])("does not treat $name business title arguments as activity descriptions", ({ name, args }) => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        { id: "business-title", name, args },
        {
          messageKey: "business-title",
          expanded: false,
          onToggleExpanded: vi.fn(),
        },
      ),
      container,
    );
    expect(container.querySelector(".chat-tool-row__title")).toBeNull();
  });

  it("previews the useful command after shell setup while retaining the full command", () => {
    const container = document.createElement("div");
    const card = {
      id: "shell-preamble",
      name: "exec",
      args: { command: "set -euo pipefail\ncd /workspace\npnpm test" },
    };
    render(
      renderToolCard(card, {
        messageKey: "shell-preamble",
        expanded: true,
        onToggleExpanded: vi.fn(),
      }),
      container,
    );
    expect(container.querySelector(".chat-tool-row__cmd")?.textContent).toBe("pnpm test");
    expect(resolveToolRowText(card)).toBe("$ pnpm test");
    expect(container.querySelector(".chat-tool-msg-body")?.textContent).toContain(
      card.args.command,
    );
  });
});
