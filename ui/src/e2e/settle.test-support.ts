import type { Locator, Page } from "playwright";
import { expect } from "vitest";

type SettledFormControl =
  | { locator: Locator; value: string }
  | { locator: Locator; checked: boolean };

async function waitForBrowserRenderBoundary(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

export async function waitForSettledFormControls(
  page: Page,
  controls: readonly SettledFormControl[],
): Promise<void> {
  const expected = controls.map((control) =>
    "value" in control ? { value: control.value } : { checked: control.checked ? "true" : "false" },
  );
  const readControls = async () =>
    Promise.all(
      controls.map(async (control) =>
        "value" in control
          ? { value: await control.locator.inputValue() }
          : { checked: await control.locator.getAttribute("aria-checked") },
      ),
    );
  await expect.poll(readControls).toEqual(expected);
  await waitForBrowserRenderBoundary(page);
  await expect.poll(readControls).toEqual(expected);
}

type CommittedStateArgs = Record<string, boolean | null | number | string>;

export async function waitForCommittedState(
  page: Page,
  probe: (arg: CommittedStateArgs) => boolean | Promise<boolean>,
  arg: CommittedStateArgs,
): Promise<void> {
  const firstMatch = await page.waitForFunction(probe, arg);
  await firstMatch.dispose();
  // A matching store read may still have an older mutation queued behind it.
  // Require the committed state to survive a browser render boundary before acting.
  await waitForBrowserRenderBoundary(page);
  const settledMatch = await page.waitForFunction(probe, arg);
  await settledMatch.dispose();
}
