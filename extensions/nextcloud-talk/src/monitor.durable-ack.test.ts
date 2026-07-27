// Nextcloud Talk webhook acknowledgement follows durable admission.
import { describe, expect, it, vi } from "vitest";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { startWebhookServer } from "./monitor.test-harness.js";
import { NextcloudTalkWebhookPayloadError } from "./webhook-spool-state.js";

describe("Nextcloud Talk durable webhook acknowledgement", () => {
  it("waits for durable admission before acknowledging", async () => {
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const onWebhook = vi.fn(async () => {
      await admission;
      return "accepted" as const;
    });
    const harness = await startWebhookServer({ path: "/nextcloud-durable-ack", onWebhook });
    const { body, headers } = createSignedCreateMessageRequest();
    let settled = false;
    const request = fetch(harness.webhookUrl, { method: "POST", headers, body }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(onWebhook).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    releaseAdmission();
    expect((await request).status).toBe(200);
  });

  it("does not acknowledge a failed durable append", async () => {
    const harness = await startWebhookServer({
      path: "/nextcloud-append-failure",
      onWebhook: vi.fn(async () => {
        throw new Error("sqlite unavailable");
      }),
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const response = await fetch(harness.webhookUrl, { method: "POST", headers, body });
    expect(response.status).toBe(500);
  });

  it("maps permanent pre-admission payload failures to 400", async () => {
    const harness = await startWebhookServer({
      path: "/nextcloud-invalid-payload",
      onWebhook: vi.fn(async () => {
        throw new NextcloudTalkWebhookPayloadError("invalid fixture");
      }),
    });
    const { body, headers } = createSignedCreateMessageRequest();
    const response = await fetch(harness.webhookUrl, { method: "POST", headers, body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid payload format" });
  });
});
