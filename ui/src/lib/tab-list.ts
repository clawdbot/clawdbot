export function handleTabListKeydown(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }

  const current = event.currentTarget;
  if (!(current instanceof HTMLElement) || current.getAttribute("role") !== "tab") {
    return;
  }
  const tabList = current.closest<HTMLElement>("[role='tablist']");
  if (!tabList) {
    return;
  }

  const vertical = tabList.getAttribute("aria-orientation") === "vertical";
  const previousKey = vertical ? "ArrowUp" : "ArrowLeft";
  const nextKey = vertical ? "ArrowDown" : "ArrowRight";
  if (![previousKey, nextKey, "Home", "End"].includes(event.key)) {
    return;
  }

  const tabs = Array.from(tabList.querySelectorAll<HTMLElement>("[role='tab']")).filter(
    (tab) => tab.closest("[role='tablist']") === tabList && !tab.hasAttribute("disabled"),
  );
  const currentIndex = tabs.indexOf(current);
  if (currentIndex < 0 || tabs.length === 0) {
    return;
  }

  const targetIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : event.key === previousKey
          ? (currentIndex - 1 + tabs.length) % tabs.length
          : (currentIndex + 1) % tabs.length;
  const target = tabs[targetIndex];
  if (!target) {
    return;
  }

  event.preventDefault();
  current.tabIndex = -1;
  target.tabIndex = 0;
  target.focus();
  target.click();
}
