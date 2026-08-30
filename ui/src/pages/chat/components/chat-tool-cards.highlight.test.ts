/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { renderToolCard } from "./chat-tool-cards.ts";

describe("tool-card source highlighting", () => {
  it.each([
    {
      name: "edit",
      args: {
        path: "example.ts",
        oldText: 'const value = "old";',
        newText: 'const value = "new";',
      },
      outputText: "Updated file",
    },
    {
      name: "edit",
      args: {
        path: "example.ts",
        oldText: "/* removed comment\ncontinued",
        newText: 'const value = "new";',
      },
    },
    { name: "write", args: { path: "example.ts", content: 'const value = "new";' } },
    {
      name: "apply_patch",
      args: {
        patch: [
          "*** Begin Patch",
          "*** Add File: example.ts",
          '+const value = "new";',
          "*** Add File: example.py",
          "+def greet():",
          '+    return "hello"',
          "*** End Patch",
        ].join("\n"),
      },
    },
  ])("highlights $name previews using their file languages", async (card) => {
    const container = document.createElement("div");
    onTestFinished(async () => {
      await vi.dynamicImportSettled();
      render(null, container);
    });
    render(
      renderToolCard({ id: "highlight", ...card }, { expanded: true, onToggleExpanded: vi.fn() }),
      container,
    );
    await vi.dynamicImportSettled();
    await vi.waitFor(() =>
      expect(container.querySelector(".tok-keyword")?.textContent).toBe("const"),
    );
    expect(container.querySelector(".tok-string")?.textContent).toMatch(/"(?:old|new)"/);
    if (card.name === "apply_patch") {
      expect(
        [...container.querySelectorAll(".tok-keyword")].map((node) => node.textContent),
      ).toContain("def");
      expect(container.querySelector(".chat-diff__row--file .tok-keyword")).toBeNull();
    }
  });

  it.each([
    { format: "text", multiple: false },
    { format: "text", multiple: true },
    { format: "structured", multiple: false },
    { format: "structured", multiple: true },
  ])(
    "highlights each side of a $format rename with multiple=$multiple",
    async ({ format, multiple }) => {
      const before = '<section data-mode="before">Hello</section>';
      const after = 'const value = "after";';
      const args =
        format === "text"
          ? {
              patch: [
                "*** Begin Patch",
                "*** Update File: example.html",
                "*** Move to: example.ts",
                "@@",
                `-${before}`,
                `+${after}`,
                ...(multiple
                  ? ["*** Add File: helper.py", "+def greet():", '+    return "hello"']
                  : []),
                "*** End Patch",
              ].join("\n"),
            }
          : {
              changes: [
                {
                  path: "example.html",
                  kind: { type: "update", move_path: "example.ts" },
                  diff: ["@@ -1 +1 @@", `-${before}`, `+${after}`].join("\n"),
                },
                ...(multiple
                  ? [
                      {
                        path: "helper.py",
                        kind: { type: "add" },
                        diff: 'def greet():\n    return "hello"\n',
                      },
                    ]
                  : []),
              ],
            };
      const container = document.createElement("div");
      onTestFinished(async () => {
        await vi.dynamicImportSettled();
        render(null, container);
      });
      render(
        renderToolCard(
          {
            id: "rename",
            name: "apply_patch",
            args,
            ...(format === "structured" && !multiple ? { outputText: "Applied patch" } : {}),
          },
          { expanded: true, onToggleExpanded: vi.fn() },
        ),
        container,
      );

      await vi.dynamicImportSettled();
      await vi.waitFor(() => {
        expect(container.querySelector(".chat-diff__row--del .tok-propertyName")?.textContent).toBe(
          "data-mode",
        );
        expect(container.querySelector(".chat-diff__row--add .tok-keyword")?.textContent).toBe(
          "const",
        );
      });
      expect(container.querySelector(".chat-diff__row--del .chat-diff__text")?.textContent).toBe(
        before,
      );
      expect(container.querySelector(".chat-diff__row--add .chat-diff__text")?.textContent).toBe(
        after,
      );
      if (multiple) {
        expect(
          [...container.querySelectorAll(".tok-keyword")].map((node) => node.textContent),
        ).toContain("def");
      }
    },
  );
});
