// Control UI proof keeps ClawHub skill artwork inside the production Gateway CSP.
import { expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI ClawHub skill icons",
  startServerBeforeBrowser: true,
});
const skillIconUrl = `https://registry.example.test/clawhub/api/v1/skill-icons/${"a".repeat(64)}`;
const detailIconUrl = `https://registry.example.test/clawhub/api/v1/skill-icons/${"b".repeat(64)}`;
const resourceBasePath = "/openclaw";
const skillIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

suite.define(() => {
  it("loads search and detail artwork through the authenticated proxy under production CSP", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await page.addInitScript(() => {
          const violations: Array<{ blockedUri: string; effectiveDirective: string }> = [];
          Object.assign(globalThis, { __openclawClawHubIconCspViolations: violations });
          document.addEventListener("securitypolicyviolation", (event) => {
            violations.push({
              blockedUri: event.blockedURI,
              effectiveDirective: event.effectiveDirective,
            });
          });
        });

        await page.addInitScript(
          ({ gatewayUrl }) => {
            window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl };
          },
          { gatewayUrl: suite.server.baseUrl.replace(/^http/u, "ws") },
        );
        const directImageRequests: string[] = [];
        const proxiedImageRequests: Array<{ authorization: string; sourceUrl: string }> = [];
        page.on("request", (request) => {
          if (request.url().startsWith(`${new URL(skillIconUrl).origin}/`)) {
            directImageRequests.push(request.url());
          }
        });

        const gateway = await installMockGateway(page, {
          basePath: resourceBasePath,
          featureMethods: ["skills.status", "skills.search", "skills.detail"],
          methodResponses: {
            "skills.status": {
              workspaceDir: "/tmp/openclaw-e2e/workspace",
              managedSkillsDir: "/tmp/openclaw-e2e/skills",
              skills: [],
            },
            "skills.search": {
              results: [
                {
                  score: 1,
                  slug: "github",
                  displayName: "GitHub",
                  summary: "GitHub integration for OpenClaw",
                  icon: skillIconUrl,
                  version: "1.2.3",
                },
              ],
            },
            "skills.detail": {
              skill: {
                slug: "github",
                displayName: "GitHub",
                summary: "GitHub integration for OpenClaw",
                icon: detailIconUrl,
                createdAt: 1_700_000_000,
                updatedAt: 1_700_000_100,
              },
            },
          },
        });

        await page.route("**/__openclaw__/catalog-icon/**", async (route) => {
          const request = route.request();
          const requestPath = new URL(request.url()).pathname;
          expect(requestPath).toMatch(/^\/openclaw\/__openclaw__\/catalog-icon\//u);
          const encodedSourceUrl = requestPath.split("/").at(-1) ?? "";
          proxiedImageRequests.push({
            authorization: request.headers().authorization ?? "",
            sourceUrl: decodeURIComponent(encodedSourceUrl),
          });
          await route.fulfill({
            body: skillIconSvg,
            contentType: "image/svg+xml",
            status: 200,
          });
        });

        const skillsUrl = `${suite.server.baseUrl}${resourceBasePath.slice(1)}/skills`;
        await page.route(skillsUrl, async (route) => {
          const response = await route.fetch();
          const body = await response.text();
          await route.fulfill({
            body,
            headers: {
              ...response.headers(),
              "content-security-policy": buildControlUiCspHeader({
                inlineScriptHashes: computeInlineScriptHashes(body),
              }),
            },
            response,
          });
        });

        const response = await page.goto(skillsUrl);
        expect(response?.status()).toBe(200);
        expect(response?.headers()["content-security-policy"]).toContain(
          "img-src 'self' data: blob: https://gravatar.com",
        );
        await gateway.waitForRequest("skills.status");
        await page.getByPlaceholder("Search ClawHub skills…").fill("github");
        await gateway.waitForRequest("skills.search");

        const searchIcon = page.locator(".plugins-item .clawhub-skill-icon");
        await expect.poll(async () => await searchIcon.count()).toBe(1);
        await expect
          .poll(
            async () => await searchIcon.evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBeGreaterThan(0);
        expect(await searchIcon.getAttribute("src")).toMatch(/^blob:/u);

        await page.getByRole("button", { name: "Open GitHub details" }).click();
        await gateway.waitForRequest("skills.detail");
        const detailIcon = page.locator(".clawhub-skill-icon--detail");
        await expect.poll(async () => await detailIcon.count()).toBe(1);
        await expect
          .poll(
            async () => await detailIcon.evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBeGreaterThan(0);
        expect(await detailIcon.getAttribute("src")).toMatch(/^blob:/u);

        expect(proxiedImageRequests.map(({ sourceUrl }) => sourceUrl)).toEqual([
          skillIconUrl,
          detailIconUrl,
        ]);
        expect(
          proxiedImageRequests.every(({ authorization }) => authorization.startsWith("Bearer ")),
        ).toBe(true);
        expect(directImageRequests).toEqual([]);
        expect(await page.locator('img[src^="https:"]').count()).toBe(0);
        expect(
          await page.evaluate(() => {
            const runtime = globalThis as typeof globalThis & {
              __openclawClawHubIconCspViolations?: Array<{
                blockedUri: string;
                effectiveDirective: string;
              }>;
            };
            return (runtime["__openclawClawHubIconCspViolations"] ?? []).filter((violation) =>
              violation.effectiveDirective.startsWith("img-src"),
            );
          }),
        ).toEqual([]);
      },
    );
  });
});
