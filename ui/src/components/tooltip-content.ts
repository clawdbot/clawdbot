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

function collectTooltipText(element: Element, checkOpacity: boolean): string {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (
    element.hasAttribute("hidden") ||
    (!checkOpacity && element.getAttribute("aria-hidden") === "true") ||
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
      element.checkVisibility({ checkOpacity, checkVisibilityCSS: true }));
  return [...element.childNodes]
    .map((node) => {
      if (isElementNode(node)) {
        return collectTooltipText(node, checkOpacity);
      }
      return node.nodeType === Node.TEXT_NODE && rendersOwnText ? (node.textContent ?? "") : "";
    })
    .join(" ");
}

export function collectTooltipNameText(element: Element): string {
  // Transparent entry animations do not hide text from accessibility APIs.
  // Replacing that name with a title would persist after the animation ends.
  return collectTooltipText(element, false);
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
  const triggerText = normalizeTooltipText(collectTooltipText(trigger, true));
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
