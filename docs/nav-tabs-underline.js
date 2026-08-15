/**
 * Docs UI enhancement that mirrors the active nav tab underline with a stable
 * animated underline element.
 */
(() => {
  const NAV_TABS_SELECTOR = ".nav-tabs";
  const ACTIVE_UNDERLINE_SELECTOR = ".nav-tabs-item > div.bg-primary";
  const UNDERLINE_CLASS = "nav-tabs-underline";
  const READY_CLASS = "nav-tabs-underline-ready";

  let navTabs = null;
  let navTabsObserver = null;
  let lastX = null;
  let lastWidth = null;

  const ensureUnderline = (tabs) => {
    let underline = tabs.querySelector(`.${UNDERLINE_CLASS}`);
    if (!underline) {
      underline = document.createElement("div");
      underline.className = UNDERLINE_CLASS;
      tabs.appendChild(underline);
    }
    return underline;
  };

  const getActiveTab = (tabs) => {
    const activeUnderline = tabs.querySelector(ACTIVE_UNDERLINE_SELECTOR);
    return activeUnderline?.closest(".nav-tabs-item") ?? null;
  };

  const updateUnderline = () => {
    if (!navTabs) {
      return;
    }

    ensureUnderline(navTabs);

    const activeTab = getActiveTab(navTabs);
    if (!activeTab) {
      navTabs.classList.remove(READY_CLASS);
      return;
    }

    const navRect = navTabs.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    const left = tabRect.left - navRect.left;

    navTabs.style.setProperty("--nav-tab-underline-x", `${left}px`);
    navTabs.style.setProperty("--nav-tab-underline-width", `${tabRect.width}px`);
    navTabs.classList.add(READY_CLASS);

    lastX = left;
    lastWidth = tabRect.width;
  };

  const scheduleUpdate = () => {
    requestAnimationFrame(updateUnderline);
  };

  const setupNavTabsObserver = (tabs) => {
    if (!tabs || tabs === navTabs) {
      return;
    }

    navTabs = tabs;
    ensureUnderline(navTabs);
    if (lastX !== null && lastWidth !== null) {
      navTabs.style.setProperty("--nav-tab-underline-x", `${lastX}px`);
      navTabs.style.setProperty("--nav-tab-underline-width", `${lastWidth}px`);
      navTabs.classList.add(READY_CLASS);
    }
    navTabsObserver?.disconnect();
    navTabsObserver = new MutationObserver(scheduleUpdate);
    navTabsObserver.observe(navTabs, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });

    scheduleUpdate();
  };

  const setupObservers = () => {
    const tabs = document.querySelector(NAV_TABS_SELECTOR);
    if (tabs) {
      setupNavTabsObserver(tabs);
    }
  };

  const rootObserver = new MutationObserver(setupObservers);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupObservers();
      rootObserver.observe(document.body, { childList: true, subtree: true });
    });
  } else {
    setupObservers();
    rootObserver.observe(document.body, { childList: true, subtree: true });
  }

  window.addEventListener("resize", scheduleUpdate);
  void document.fonts?.ready?.then(scheduleUpdate, () => {});
})();
