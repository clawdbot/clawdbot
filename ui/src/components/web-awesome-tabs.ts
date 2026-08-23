// Route-local registration keeps tab internals out of startup.
import WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import "@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js";
import "@awesome.me/webawesome/dist/components/tab/tab.js";

/** Web Awesome does not forward the host label to its shadow tablist. */
export function syncTabGroupLabel(element: Element | undefined, label: string) {
  if (!(element instanceof WaTabGroup)) {
    return;
  }
  void element.updateComplete.then(() => {
    const tablist = element.shadowRoot?.querySelector('[role="tablist"]');
    if (element.isConnected && tablist instanceof HTMLElement) {
      tablist.setAttribute("aria-label", label);
    }
  });
}
