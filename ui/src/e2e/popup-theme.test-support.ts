import type { Locator } from "playwright";

type PopupPaint = {
  background: string;
  border: string;
  shadow: string;
};

export async function readThemedPopupPaint(
  host: Locator,
  partName: "body" | "submenu",
): Promise<{ actual: PopupPaint; expected: PopupPaint }> {
  return host.evaluate((element, popupPart) => {
    const surface = element.shadowRoot?.querySelector<HTMLElement>(`[part~="${popupPart}"]`);
    if (!surface) {
      throw new Error(`Web Awesome ${popupPart} surface did not render`);
    }
    const probe = document.createElement("span");
    probe.style.cssText =
      "position:fixed;background:var(--popover);border:1px solid var(--overlay-border);box-shadow:var(--overlay-shadow)";
    document.body.append(probe);
    const actual = getComputedStyle(surface);
    const expected = getComputedStyle(probe);
    const result = {
      actual: {
        background: actual.backgroundColor,
        border: actual.borderTopColor,
        shadow: actual.boxShadow,
      },
      expected: {
        background: expected.backgroundColor,
        border: expected.borderTopColor,
        shadow: expected.boxShadow,
      },
    };
    probe.remove();
    return result;
  }, partName);
}
