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
  // waitForFunction treats a Promise as truthy before its boolean resolves.
  const readCommittedState = () => page.evaluate(probe, arg);
  await expect.poll(readCommittedState).toBe(true);
  // A matching store read may still have an older mutation queued behind it.
  // Require the committed state to survive a browser render boundary before acting.
  await waitForBrowserRenderBoundary(page);
  await expect.poll(readCommittedState).toBe(true);
}

export async function waitForCommittedComposerDraft(
  page: Page,
  scopeKey: string,
  text: string | null,
  attachments: number | readonly string[],
): Promise<void> {
  await waitForCommittedState(
    page,
    async (expected) => {
      const app = document.querySelector("openclaw-app") as HTMLElement & {
        runtime?: {
          context: {
            gateway: {
              connection: { gatewayUrl: string };
              snapshot: { client: { recoveryScope?: string } | null };
            };
          };
        };
      };
      const gateway = app.runtime?.context.gateway;
      const recoveryScope = gateway?.snapshot.client?.recoveryScope;
      if (
        !gateway ||
        !recoveryScope ||
        !(await indexedDB.databases()).some((db) => db.name === "openclaw-control-ui")
      ) {
        return false;
      }
      const gatewayOwner = gateway.connection.gatewayUrl.trim() || "default";
      // Browser probes cannot import Vitest-transformed modules. Read the exact
      // durable owner/key and await the transaction, independently of the renderer.
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("openclaw-control-ui");
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener(
          "error",
          () => reject(request.error ?? new Error("IndexedDB open failed")),
          { once: true },
        );
      });
      try {
        type DraftRecord = {
          revision: number;
          text: string;
          attachments: { fileName?: string }[];
        };
        const draft = await new Promise<DraftRecord | undefined>((resolve, reject) => {
          const transaction = database.transaction("composerDrafts", "readonly");
          const request = transaction
            .objectStore("composerDrafts")
            .get(JSON.stringify([gatewayOwner, recoveryScope, expected.scopeKey])) as IDBRequest<
            DraftRecord | undefined
          >;
          transaction.addEventListener("complete", () => resolve(request.result), { once: true });
          transaction.addEventListener(
            "abort",
            () => reject(transaction.error ?? new Error("IndexedDB read aborted")),
            { once: true },
          );
          transaction.addEventListener(
            "error",
            () => reject(transaction.error ?? new Error("IndexedDB read failed")),
            { once: true },
          );
        });
        if (!draft) {
          return false;
        }
        if (expected.text === null) {
          return (
            typeof draft.revision === "number" &&
            draft.text === "" &&
            draft.attachments.length === 0
          );
        }
        return (
          draft.text === expected.text &&
          draft.attachments.length === expected.attachmentCount &&
          (expected.attachmentNames === null ||
            JSON.stringify(draft.attachments.map((a) => a.fileName)) === expected.attachmentNames)
        );
      } finally {
        database.close();
      }
    },
    {
      scopeKey,
      text,
      attachmentCount: typeof attachments === "number" ? attachments : attachments.length,
      attachmentNames: typeof attachments === "number" ? null : JSON.stringify(attachments),
    },
  );
}
