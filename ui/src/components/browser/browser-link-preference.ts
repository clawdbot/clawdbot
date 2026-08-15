const STORAGE_KEY = "openclaw.browser.openLinksInControlUi.v1";

export function readBrowserLinkPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeBrowserLinkPreference(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in hardened or ephemeral hosts.
  }
}
