import { expect, it } from "vitest";
import {
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pastePng,
  waitForCommittedNewSessionDraft,
} from "./new-session-page.test-support.ts";

type AttachmentUrlProof = {
  created: string[];
  revoked: string[];
  deferNextRead: boolean;
  deferredReads: number;
  releaseDeferredReads: () => void;
};

declare global {
  interface Window {
    attachmentUrlProof: AttachmentUrlProof;
  }
}

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("releases pasted image previews after remove, reset, restored removal, and success", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        await page.addInitScript(() => {
          const createObjectURL = URL.createObjectURL.bind(URL);
          const revokeObjectURL = URL.revokeObjectURL.bind(URL);
          const readAsDataURL = Object.getOwnPropertyDescriptor(
            FileReader.prototype,
            "readAsDataURL",
          )?.value as FileReader["readAsDataURL"];
          const deferredReads: Array<{ blob: Blob; reader: FileReader }> = [];
          const proof: AttachmentUrlProof = {
            created: [],
            revoked: [],
            deferNextRead: false,
            deferredReads: 0,
            releaseDeferredReads: () => {},
          };
          window.attachmentUrlProof = proof;
          URL.createObjectURL = (blob: Blob) => {
            const url = createObjectURL(blob);
            proof.created.push(url);
            return url;
          };
          URL.revokeObjectURL = (url: string) => {
            proof.revoked.push(url);
            revokeObjectURL(url);
          };
          FileReader.prototype.readAsDataURL = function (blob: Blob) {
            if (!proof.deferNextRead) {
              return readAsDataURL.call(this, blob);
            }
            proof.deferNextRead = false;
            deferredReads.push({ blob, reader: this });
            proof.deferredReads = deferredReads.length;
          };
          proof.releaseDeferredReads = () => {
            for (const { blob, reader } of deferredReads.splice(0)) {
              readAsDataURL.call(reader, blob);
            }
            proof.deferredReads = 0;
          };
        });
        await installMockGateway(page, {
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
              agents: [
                { id: "main", name: "Main" },
                { id: "writer", name: "Writer" },
              ],
            },
            "sessions.create": { key: "agent:main:preview-cleanup", runStarted: true },
          },
        });
        const readObjectUrlState = () =>
          page.evaluate(() => {
            const proof = window.attachmentUrlProof;
            const created = new Set(proof.created);
            const revoked = new Set(proof.revoked);
            return {
              active: proof.created.filter((url) => !revoked.has(url)).length,
              created: proof.created.length,
              duplicateRevocations: proof.revoked.length - revoked.size,
              unknownRevocations: proof.revoked.filter((url) => !created.has(url)).length,
            };
          });
        const expectActiveObjectUrls = async (active: number) => {
          await expect
            .poll(async () => {
              const { created: _created, ...state } = await readObjectUrlState();
              return state;
            })
            .toEqual({ active, duplicateRevocations: 0, unknownRevocations: 0 });
        };
        const navigate = (routeId: string, search = "") =>
          page.evaluate(
            ({ targetRouteId, targetSearch }) => {
              const app = document.querySelector("openclaw-app") as HTMLElement & {
                runtime?: {
                  context: {
                    navigate: (routeId: string, options?: { search?: string }) => void;
                  };
                };
              };
              if (!app.runtime) {
                throw new Error("OpenClaw application runtime is unavailable");
              }
              app.runtime.context.navigate(targetRouteId, { search: targetSearch });
            },
            { targetRouteId: routeId, targetSearch: search },
          );
        await page.goto(`${suite.server.baseUrl}new`);
        const composer = page.locator(".new-session-page__message");

        await pastePng(composer);
        await page.getByRole("img", { name: "pixel.png" }).waitFor();
        await page.getByRole("button", { name: "Remove attachment" }).click();
        await expectActiveObjectUrls(0);

        await pastePng(composer);
        await page.getByRole("img", { name: "pixel.png" }).waitFor();
        await waitForCommittedNewSessionDraft(page, "", 1);
        // Synthetic paste leaves the pointer over the replacement remove button.
        await page.mouse.move(0, 0);
        const agentDropdown = page.locator(".new-session-page__select--agent wa-dropdown");
        await page.locator(".new-session-page__select--agent .agent-select__trigger").click();
        await expect
          .poll(() =>
            agentDropdown.evaluate(
              (dropdown) => (dropdown as HTMLElement & { open: boolean }).open,
            ),
          )
          .toBe(true);
        await navigate("new-session", "?agent=main&catalog=missing");
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (
                  document.querySelector(".new-session-page__select--agent wa-dropdown") as
                    | (HTMLElement & { open: boolean })
                    | null
                )?.open ?? false,
            ),
          )
          .toBe(false);
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(0);
        await expectActiveObjectUrls(0);

        await page.evaluate(() => {
          window.attachmentUrlProof.deferNextRead = true;
        });
        await navigate("new-session");
        await composer.waitFor();
        await expect
          .poll(() => page.evaluate(() => window.attachmentUrlProof.deferredReads))
          .toBe(1);
        const createdBeforeHydration = (await readObjectUrlState()).created;
        await page.evaluate(() => window.attachmentUrlProof.releaseDeferredReads());
        await expect.poll(readObjectUrlState).toEqual({
          active: 1,
          created: createdBeforeHydration + 1,
          duplicateRevocations: 0,
          unknownRevocations: 0,
        });
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(1);
        await page.getByRole("button", { name: "Remove attachment" }).click();
        await expectActiveObjectUrls(0);

        await pastePng(composer);
        await page.getByRole("img", { name: "pixel.png" }).waitFor();
        await waitForCommittedNewSessionDraft(page, "", 1);
        await navigate("chat");
        await page.waitForURL((url) => url.pathname.endsWith("/chat"));
        await expectActiveObjectUrls(1);

        await navigate("new-session");
        await composer.waitFor();
        await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(1);
        await page.getByRole("button", { name: "Remove attachment" }).click();
        await expectActiveObjectUrls(0);

        await pastePng(composer);
        await page.getByRole("img", { name: "pixel.png" }).waitFor();
        await expectActiveObjectUrls(1);
        await page.getByRole("button", { name: "Start session" }).click();
        await page.waitForURL(
          (url) => url.pathname === controlUiSessionPath("agent:main:preview-cleanup"),
        );
        await expectActiveObjectUrls(0);
      },
    );
  });
});
