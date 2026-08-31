import { afterEach, describe, expect, it } from "vitest";
import "../styles.css";
import "../styles/cron.css";
import "../styles/usage.css";
import "./web-awesome.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

type DropdownItemElement = HTMLElement & {
  checked: boolean;
  type: "checkbox" | "normal";
  updateComplete: Promise<boolean>;
};

afterEach(() => {
  document.body.replaceChildren();
});

function createMenuItem(label: string, checkbox: boolean, checked = false) {
  const item = document.createElement("wa-dropdown-item") as DropdownItemElement;
  item.type = checkbox ? "checkbox" : "normal";
  item.checked = checked;
  item.setAttribute("checkbox-adjacent", "");
  const icon = document.createElement("span");
  icon.slot = "icon";
  icon.textContent = "#";
  item.append(icon, label);
  return item;
}

function partBounds(item: DropdownItemElement, part: string): DOMRect {
  const element = item.shadowRoot?.querySelector<HTMLElement>(`[part="${part}"]`);
  expect(element, `${part} part should exist`).not.toBeNull();
  return element!.getBoundingClientRect();
}

describe.skipIf(!hasBrowserLayout)("menu selection check alignment", () => {
  it("keeps the icon column flush left and selection checks in the trailing rail", async () => {
    const menu = document.createElement("div");
    menu.style.width = "240px";
    const selected = createMenuItem("Selected", true, true);
    const unselected = createMenuItem("Unselected", true);
    const command = createMenuItem("Command", false);
    const usageSelected = createMenuItem("Usage selected", true, true);
    selected.className = "cron-filter-dropdown__option";
    unselected.className = "cron-filter-dropdown__option";
    command.className = "cron-filter-dropdown__option";
    usageSelected.className = "usage-filter-option";
    menu.append(selected, unselected, command, usageSelected);
    document.body.append(menu);
    await Promise.all([
      selected.updateComplete,
      unselected.updateComplete,
      command.updateComplete,
      usageSelected.updateComplete,
    ]);

    expect(selected.hasAttribute("checkbox-adjacent")).toBe(true);
    expect(unselected.hasAttribute("checkbox-adjacent")).toBe(true);
    expect(command.hasAttribute("checkbox-adjacent")).toBe(true);

    const selectedCheck = partBounds(selected, "checkmark");
    const selectedLabel = partBounds(selected, "label");
    expect(selectedCheck.width).toBeGreaterThan(0);
    expect(selectedLabel.width).toBeGreaterThan(0);
    expect(selectedCheck.left).toBeGreaterThanOrEqual(selectedLabel.right);
    expect(Math.abs(selectedCheck.top - selectedLabel.top)).toBeLessThanOrEqual(2);

    const unselectedCheck = partBounds(unselected, "checkmark");
    const unselectedLabel = partBounds(unselected, "label");
    expect(unselectedCheck.left).toBeGreaterThanOrEqual(unselectedLabel.right);

    const usageCheck = partBounds(usageSelected, "checkmark");
    const usageLabel = partBounds(usageSelected, "label");
    expect(usageCheck.left).toBeGreaterThanOrEqual(usageLabel.right);

    const iconStarts = [selected, unselected, command].map((item) => partBounds(item, "icon").left);
    expect(Math.max(...iconStarts) - Math.min(...iconStarts)).toBeLessThanOrEqual(1);
  });
});
