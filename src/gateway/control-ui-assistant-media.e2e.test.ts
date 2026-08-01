// Control UI assistant media e2e tests verify scoped media-ticket access through gateway HTTP routes.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const CONTROL_UI_E2E_TOKEN = "test-gateway-token-1234567890";

describe("Control UI assistant media e2e", () => {
  test("serves local assistant media through scoped tickets over the gateway HTTP route", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };

    const mediaDir = path.join(stateDir, "media", "control-ui-assistant-media-e2e");
    await fs.mkdir(mediaDir, { recursive: true });
    const filePath = path.join(mediaDir, "测试 ticketed (final).txt");
    await fs.writeFile(filePath, "ticketed control ui media\n", "utf8");

    await withGatewayServer(
      async ({ port }) => {
        const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
        const sourceParam = encodeURIComponent(filePath);

        const metadata = await fetch(`${route}?meta=1&source=${sourceParam}`, {
          headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
        });
        expect(metadata.status).toBe(200);
        const payload = (await metadata.json()) as {
          available?: boolean;
          mediaTicket?: string;
          mediaTicketExpiresAt?: string;
        };
        expect(payload.available).toBe(true);
        expect(payload.mediaTicket).toMatch(/^v1\./);
        expect(Date.parse(payload.mediaTicketExpiresAt ?? "")).not.toBeNaN();

        const withoutTicket = await fetch(`${route}?source=${sourceParam}`);
        expect(withoutTicket.status).toBe(401);

        const ticketed = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(ticketed.status).toBe(200);
        expect(ticketed.headers.get("content-disposition")).toBe(
          `attachment; filename="__ ticketed (final).txt"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20ticketed%20%28final%29.txt`,
        );
        expect(await ticketed.text()).toBe("ticketed control ui media\n");

        const ranged = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
          { headers: { Range: "bytes=9-15" } },
        );
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("accept-ranges")).toBe("bytes");
        expect(ranged.headers.get("content-range")).toBe("bytes 9-15/26");
        expect(ranged.headers.get("content-length")).toBe("7");
        expect(ranged.headers.get("etag")).toBeNull();
        expect(ranged.headers.get("last-modified")).toBeNull();
        expect(await ranged.text()).toBe("control");

        const mutableFilePath = path.join(mediaDir, "mutable-preview.txt");
        const preservedTime = new Date("2026-07-01T00:00:00.000Z");
        await fs.writeFile(mutableFilePath, "AAAA", "utf8");
        await fs.utimes(mutableFilePath, preservedTime, preservedTime);
        const originalStat = await fs.stat(mutableFilePath);
        const legacyEtag = `"${createHash("sha256")
          .update(`${originalStat.size}:${originalStat.mtimeMs}`)
          .digest("base64url")}"`;
        const legacyLastModified = originalStat.mtime.toUTCString();
        const mutableUrl = `${route}?source=${encodeURIComponent(mutableFilePath)}`;
        const initialRange = await fetch(mutableUrl, {
          headers: {
            Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}`,
            Range: "bytes=0-1",
          },
        });
        expect(initialRange.status).toBe(206);
        expect(await initialRange.text()).toBe("AA");
        expect(initialRange.headers.get("etag")).toBeNull();
        expect(initialRange.headers.get("last-modified")).toBeNull();

        await fs.writeFile(mutableFilePath, "BBBB", "utf8");
        await fs.utimes(mutableFilePath, preservedTime, preservedTime);
        const revalidatedByEtag = await fetch(mutableUrl, {
          headers: {
            Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}`,
            "If-None-Match": legacyEtag,
          },
        });
        expect(revalidatedByEtag.status).toBe(200);
        expect(revalidatedByEtag.headers.get("etag")).toBeNull();
        expect(revalidatedByEtag.headers.get("last-modified")).toBeNull();
        expect(await revalidatedByEtag.text()).toBe("BBBB");

        const revalidatedByDate = await fetch(mutableUrl, {
          headers: {
            Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}`,
            "If-Modified-Since": legacyLastModified,
          },
        });
        expect(revalidatedByDate.status).toBe(200);
        expect(revalidatedByDate.headers.get("etag")).toBeNull();
        expect(revalidatedByDate.headers.get("last-modified")).toBeNull();
        expect(await revalidatedByDate.text()).toBe("BBBB");

        const resumed = await fetch(mutableUrl, {
          headers: {
            Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}`,
            Range: "bytes=2-3",
            "If-Range": legacyEtag,
          },
        });
        expect(resumed.status).toBe(200);
        expect(resumed.headers.get("etag")).toBeNull();
        expect(resumed.headers.get("last-modified")).toBeNull();
        expect(resumed.headers.get("content-range")).toBeNull();
        expect(await resumed.text()).toBe("BBBB");

        const resumedByDate = await fetch(mutableUrl, {
          headers: {
            Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}`,
            Range: "bytes=2-3",
            "If-Range": legacyLastModified,
          },
        });
        expect(resumedByDate.status).toBe(200);
        expect(resumedByDate.headers.get("etag")).toBeNull();
        expect(resumedByDate.headers.get("last-modified")).toBeNull();
        expect(resumedByDate.headers.get("content-range")).toBeNull();
        expect(await resumedByDate.text()).toBe("BBBB");

        const currentRange = await fetch(mutableUrl, {
          headers: {
            Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}`,
            Range: "bytes=2-3",
          },
        });
        expect(currentRange.status).toBe(206);
        expect(currentRange.headers.get("content-range")).toBe("bytes 2-3/4");
        expect(await currentRange.text()).toBe("BB");

        const head = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
          { method: "HEAD" },
        );
        expect(head.status).toBe(200);
        expect(head.headers.get("accept-ranges")).toBe("bytes");
        expect(head.headers.get("content-length")).toBe("26");
        expect(head.headers.get("etag")).toBeNull();
        expect(head.headers.get("last-modified")).toBeNull();
        expect(await head.text()).toBe("");

        for (const method of ["GET", "HEAD"]) {
          const notModified = await fetch(
            `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
            {
              method,
              headers: {
                "If-None-Match": "*",
                Range: "bytes=9-15",
                "If-Range": '"stale"',
              },
            },
          );
          expect(notModified.status).toBe(304);
          expect(notModified.headers.get("etag")).toBeNull();
          expect(notModified.headers.get("last-modified")).toBeNull();
          expect(notModified.headers.get("content-length")).toBeNull();
          expect(await notModified.text()).toBe("");
        }

        const emptyFilePath = path.join(mediaDir, "empty.bin");
        await fs.writeFile(emptyFilePath, Buffer.alloc(0));
        const empty = await fetch(`${route}?source=${encodeURIComponent(emptyFilePath)}`, {
          headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
        });
        expect(empty.status).toBe(200);
        expect(empty.headers.get("content-length")).toBe("0");
        expect((await empty.arrayBuffer()).byteLength).toBe(0);

        const otherFilePath = path.join(mediaDir, "other-preview.txt");
        await fs.writeFile(otherFilePath, "other media\n", "utf8");
        const wrongSource = await fetch(
          `${route}?source=${encodeURIComponent(otherFilePath)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(wrongSource.status).toBe(401);
      },
      {
        serverOptions: {
          auth: { mode: "token", token: CONTROL_UI_E2E_TOKEN },
          controlUiEnabled: true,
        },
      },
    );
  });
});
