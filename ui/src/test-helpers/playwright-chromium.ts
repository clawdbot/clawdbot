import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";

export type ChromiumTestContext = {
  context: BrowserContext;
  close: () => Promise<void>;
};

type ChromiumLaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

function resolveChromiumProfileRoot(executablePath: string | undefined): string {
  if (process.platform === "linux" && executablePath?.startsWith("/snap/")) {
    return "/tmp";
  }
  return tmpdir();
}

export async function launchChromiumTestContext(
  options: ChromiumLaunchOptions,
): Promise<ChromiumTestContext> {
  const profileDir = await mkdtemp(
    path.join(resolveChromiumProfileRoot(options.executablePath), "openclaw-playwright-"),
  );
  try {
    const context = await chromium.launchPersistentContext(profileDir, options);
    return {
      context,
      close: async () => {
        try {
          await context.close();
        } finally {
          await rm(profileDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
}
