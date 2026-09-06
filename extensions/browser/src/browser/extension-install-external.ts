import fs from "node:fs/promises";
import path from "node:path";
import {
  assertOwnedPath,
  chromeProductRoots,
  type ChromeProductRoot,
  ensurePrivateDirectory,
  type ExtensionInstallDeps,
  pathInfo,
} from "./extension-install-layout.js";

export const FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID = "kcdjddhmeafeomebliikmbpblkmkfoig";
export const FOUNDATION_CHROME_WEB_STORE_URL = `https://chromewebstore.google.com/detail/openclaw/${FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID}`;
const STORE_UPDATE_URL = "https://clients2.google.com/service/update2/crx";
// Chromium ignores unknown fields in each external-extension dictionary.
const OWNED_REQUEST = {
  external_update_url: STORE_UPDATE_URL,
  openclawOwnership: "browser-store-install-v1",
};

export type ChromeStoreInstallRequest = {
  browser: string;
  path: string;
  state: "missing" | "requested" | "foreign" | "invalid";
  issue?: string;
};

function requestPath(root: ChromeProductRoot): string {
  // Chromium resolves this beneath DIR_USER_DATA, shared by its profiles.
  return path.join(
    root.userDataDir,
    "External Extensions",
    `${FOUNDATION_CHROME_WEB_STORE_EXTENSION_ID}.json`,
  );
}

async function inspectRequest(root: ChromeProductRoot): Promise<ChromeStoreInstallRequest> {
  const target = requestPath(root);
  const result = { browser: root.label, path: target };
  try {
    if (!(await pathInfo(target))) {
      return { ...result, state: "missing" };
    }
    await assertOwnedPath(root.userDataDir, "directory");
    await assertOwnedPath(path.dirname(target), "directory");
    await assertOwnedPath(target, "file");
    if ((await fs.stat(target)).size > 4_096) {
      throw new Error("Store install registration exceeds 4 KiB");
    }
    const value: unknown = JSON.parse(await fs.readFile(target, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !("external_update_url" in value) ||
      value.external_update_url !== OWNED_REQUEST.external_update_url ||
      !("openclawOwnership" in value) ||
      value.openclawOwnership !== OWNED_REQUEST.openclawOwnership
    ) {
      return {
        ...result,
        state: "foreign",
        issue: "Store install registration is not OpenClaw-owned",
      };
    }
    return { ...result, state: "requested" };
  } catch (error) {
    return {
      ...result,
      state: "invalid",
      issue: error instanceof Error ? error.message : String(error),
    };
  }
}

function supportedRoots(deps: ExtensionInstallDeps): ChromeProductRoot[] {
  return (deps.platform ?? process.platform) === "darwin"
    ? chromeProductRoots(deps).filter((root) => root.product === "chrome")
    : [];
}

/** Registration requests installation; only Chrome can install and approve it. */
export async function chromeStoreInstallRequests(
  deps: ExtensionInstallDeps = {},
): Promise<ChromeStoreInstallRequest[]> {
  return await Promise.all(supportedRoots(deps).map(inspectRequest));
}

/** The caller must register the native host successfully before requesting installation. */
export async function requestChromeStoreInstall(
  root: ChromeProductRoot,
  deps: ExtensionInstallDeps,
): Promise<ChromeStoreInstallRequest | undefined> {
  if (!supportedRoots(deps).some((candidate) => candidate.userDataDir === root.userDataDir)) {
    return undefined;
  }
  const before = await inspectRequest(root);
  if (before.state === "requested") {
    return before;
  }
  if (before.state !== "missing") {
    throw new Error(before.issue);
  }
  await assertOwnedPath(root.userDataDir, "directory");
  await ensurePrivateDirectory(path.dirname(before.path));
  await fs.writeFile(before.path, `${JSON.stringify(OWNED_REQUEST, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return await inspectRequest(root);
}

/** Chrome may remove an externally installed extension after this request is removed. */
export async function removeChromeStoreInstallRequests(
  deps: ExtensionInstallDeps = {},
): Promise<{ removed: string[]; refused: string[] }> {
  const removed: string[] = [];
  const refused: string[] = [];
  for (const root of supportedRoots(deps)) {
    const current = await inspectRequest(root);
    if (current.state === "requested") {
      await fs.unlink(current.path);
      removed.push(current.path);
    } else if (current.state !== "missing") {
      refused.push(current.path);
    }
  }
  return { removed, refused };
}
