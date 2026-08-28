export function normalizeTooltipText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function isTooltipTriggerElement(element: unknown): element is HTMLElement | SVGElement {
  return (
    typeof element === "object" &&
    element !== null &&
    "namespaceURI" in element &&
    (element.namespaceURI === "http://www.w3.org/1999/xhtml" ||
      element.namespaceURI === "http://www.w3.org/2000/svg")
  );
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

export function collectTooltipVisibleText(element: Element): string {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (
    element.hasAttribute("hidden") ||
    style?.display === "none" ||
    style?.contentVisibility === "hidden"
  ) {
    return "";
  }
  const rendersOwnText =
    style?.visibility !== "hidden" &&
    style?.visibility !== "collapse" &&
    (style?.display === "contents" ||
      typeof element.checkVisibility !== "function" ||
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  return [...element.childNodes]
    .map((node) => {
      if (isElementNode(node)) {
        return collectTooltipVisibleText(node);
      }
      return node.nodeType === Node.TEXT_NODE && rendersOwnText ? (node.textContent ?? "") : "";
    })
    .join(" ");
}

function hasTooltipOverflow(element: Element) {
  return (
    element.matches("[data-tooltip-overflow]") ||
    element.scrollWidth > element.clientWidth ||
    element.scrollHeight > element.clientHeight
  );
}

export function isTooltipTextRedundant(content: string, trigger: Element) {
  const tooltipText = normalizeTooltipText(content);
  const triggerText = normalizeTooltipText(collectTooltipVisibleText(trigger));
  if (!tooltipText || !triggerText.includes(tooltipText)) {
    return false;
  }
  if (hasTooltipOverflow(trigger)) {
    return false;
  }
  for (const element of trigger.querySelectorAll("*")) {
    if (isTooltipTriggerElement(element) && hasTooltipOverflow(element)) {
      return false;
    }
  }
  return true;
}
