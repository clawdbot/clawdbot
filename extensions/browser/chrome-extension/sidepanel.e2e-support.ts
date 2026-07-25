import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isSidePanelTarget(target: { url: string }): boolean {
  try {
    return new URL(target.url).pathname.endsWith("/sidepanel.html");
  } catch {
    return false;
  }
}

export async function resolveChromiumExecutable(): Promise<string | undefined> {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const candidates = [override, "/usr/bin/chromium-browser", "/usr/bin/chromium"].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to Playwright's managed Chromium.
    }
  }
  return undefined;
}

export async function copyCopilotSidepanelExtension(tempDirs: {
  make: (prefix: string) => string;
}): Promise<string> {
  const extensionDir = path.dirname(fileURLToPath(import.meta.url));
  const target = tempDirs.make("openclaw-copilot-extension-");
  await fs.cp(extensionDir, target, {
    recursive: true,
    filter: (source) => !source.endsWith(".test.ts"),
  });
  await fs.writeFile(
    path.join(target, "e2e-launcher.html"),
    '<!doctype html><button id="open">Open tab panel</button><script type="module" src="e2e-launcher.js"></script>',
  );
  await fs.writeFile(
    path.join(target, "e2e-launcher.js"),
    `const tab = await chrome.tabs.getCurrent();
    const panel = await chrome.runtime.sendMessage({ type: "prepareCopilotPanel", tabId: tab.id });
    if (!panel?.ok) throw new Error(panel?.error ?? "panel prepare failed");
    document.body.dataset.ready = "true";
    document.querySelector("#open").addEventListener("click", async () => {
      try {
        await chrome.sidePanel.setOptions({ tabId: tab.id, path: panel.path, enabled: true });
        await chrome.sidePanel.open({ tabId: tab.id });
        document.body.dataset.opened = "true";
      } catch (error) {
        document.body.dataset.error = error instanceof Error ? error.message : String(error);
      }
    });\n`,
  );
  return target;
}
