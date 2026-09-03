import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderGroupedMessage } from "./chat-message-bubble.ts";

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
  window.getSelection()?.removeAllRanges();
});

function fixture(mode: "inline" | "standalone") {
  const rows = ["a", "b"].map((suffix) => {
    const output = `Applied ${suffix}`;
    const args = JSON.stringify({
      changes: [
        { path: `src/${suffix}.ts`, kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" },
      ],
    });
    return {
      key: `message:${suffix}`,
      output,
      message: {
        role: "assistant",
        timestamp: 1_700_000_000_000,
        ...(mode === "standalone" ? { toolCallId: "shared-call", toolName: "apply_patch" } : {}),
        content: [
          ...(mode === "standalone" ? [{ type: "text", text: output }] : []),
          { type: "toolcall", id: "shared-call", name: "apply_patch", arguments: args },
          { type: "toolresult", id: "shared-call", name: "apply_patch", text: output },
        ],
      },
    };
  });
  const container = document.body.appendChild(document.createElement("div"));
  containers.push(container);
  const toggledKeys: string[] = [];
  const expansion = new Map<string, boolean>();
  for (const row of rows) {
    expansion.set(`${row.key}:toolcard:0`, true);
    expansion.set(`toolmsg:${row.key}`, true);
  }
  const draw = () =>
    render(
      html`${rows.map((row) =>
        renderGroupedMessage(row.message, row.key, {
          isStreaming: false,
          showReasoning: false,
          showToolCalls: true,
          isToolExpanded: (key) => expansion.get(key) ?? false,
          isToolMessageExpanded: (key) => expansion.get(key),
          onToggleToolExpanded: toggle,
          onToggleToolMessageExpanded: toggle,
        }),
      )}`,
      container,
    );
  function toggle(key: string) {
    toggledKeys.push(key);
    expansion.set(key, !expansion.get(key));
    draw();
  }
  return { rows, container, draw, toggledKeys };
}

async function settleTabs(container: HTMLElement) {
  await Promise.all(
    ["wa-tab-group", "wa-tab", "wa-tab-panel"].map((tag) => customElements.whenDefined(tag)),
  );
  await Promise.all(
    Array.from(
      container.querySelectorAll<HTMLElement & { updateComplete: Promise<unknown> }>(
        "wa-tab-group, wa-tab, wa-tab-panel",
      ),
      (element) => element.updateComplete,
    ),
  );
}

describe
  .skipIf(navigator.userAgent.toLowerCase().includes("jsdom"))
  .each(["inline", "standalone"] as const)("%s tool message disclosures", (mode) => {
  it("preserves message-scoped IDs and independent Raw tabs for reused call IDs", async () => {
    const { rows, container, draw, toggledKeys } = fixture(mode);
    draw();
    await settleTabs(container);
    const bubbles = Array.from(container.querySelectorAll<HTMLElement>(".chat-bubble"));
    expect(bubbles.map((bubble) => bubble.dataset.messageId)).toEqual(rows.map((row) => row.key));
    expect(container.querySelectorAll(".chat-tools-inline")).toHaveLength(
      mode === "inline" ? 2 : 0,
    );
    expect(container.querySelectorAll("wa-tab-group")).toHaveLength(2);
    const ids = Array.from(
      container.querySelectorAll("wa-tab, wa-tab-panel"),
      (element) => element.id,
    );
    expect(ids).toEqual(
      rows.flatMap(({ key }) =>
        ["diff-tab", "raw-tab", "diff-panel", "raw-panel"].map(
          (suffix) => `${key}:shared-call-${suffix}`,
        ),
      ),
    );
    expect(new Set(ids).size).toBe(8);

    await vi.waitFor(() => {
      for (const bubble of bubbles) {
        for (const name of ["diff", "raw"]) {
          const tab = bubble.querySelector(`wa-tab[panel="${name}"]`)!;
          const panel = bubble.querySelector(`wa-tab-panel[name="${name}"]`)!;
          expect(tab.getAttribute("aria-controls")).toBe(panel.id);
          expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
        }
      }
    });

    const toggleSelector =
      mode === "inline" ? ".chat-tool-row__toggle" : "button.chat-tool-msg-summary";
    const disclosureKey =
      mode === "inline" ? `${rows[0]!.key}:toolcard:0` : `toolmsg:${rows[0]!.key}`;
    bubbles[0]!.querySelector<HTMLButtonElement>(toggleSelector)!.click();
    expect(toggledKeys).toEqual([disclosureKey]);
    expect(bubbles[0]!.querySelector("wa-tab-group")).toBeNull();
    expect(bubbles[1]!.querySelector("wa-tab-group")).not.toBeNull();
    bubbles[0]!.querySelector<HTMLButtonElement>(toggleSelector)!.click();
    expect(toggledKeys).toEqual([disclosureKey, disclosureKey]);
    await settleTabs(container);

    bubbles[0]!.querySelector<HTMLElement>('wa-tab[panel="raw"]')!.click();
    await settleTabs(container);
    expect(bubbles[0]!.querySelector('wa-tab-panel[name="raw"]')!.hasAttribute("active")).toBe(
      true,
    );
    expect(bubbles[0]!.querySelector('wa-tab-panel[name="diff"]')!.hasAttribute("active")).toBe(
      false,
    );
    expect(bubbles[1]!.querySelector('wa-tab-panel[name="diff"]')!.hasAttribute("active")).toBe(
      true,
    );
    expect(bubbles[1]!.querySelector('wa-tab-panel[name="raw"]')!.hasAttribute("active")).toBe(
      false,
    );
    expect(
      bubbles.map((bubble) => bubble.querySelector('wa-tab-panel[name="raw"] code')!.textContent),
    ).toEqual(rows.map((row) => row.output));
  });
});
