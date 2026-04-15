import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSlackHttpRequest,
  normalizeSlackWebhookPath,
  registerSlackHttpHandler,
} from "./registry.js";

describe("normalizeSlackWebhookPath", () => {
  it("returns the default path when input is empty", () => {
    expect(normalizeSlackWebhookPath()).toBe("/slack/events");
    expect(normalizeSlackWebhookPath(" ")).toBe("/slack/events");
  });

  it("ensures a leading slash", () => {
    expect(normalizeSlackWebhookPath("slack/events")).toBe("/slack/events");
    expect(normalizeSlackWebhookPath("/hooks/slack")).toBe("/hooks/slack");
  });
});

describe("registerSlackHttpHandler", () => {
  const unregisters: Array<() => void> = [];

  afterEach(() => {
    for (const unregister of unregisters.splice(0)) {
      unregister();
    }
  });

  it("routes requests to a registered handler", async () => {
    const handler = vi.fn();
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/events",
        handler,
      }),
    );

    const req = { url: "/slack/events?foo=bar" } as IncomingMessage;
    const res = {} as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledWith(req, res);
  });

  it("returns false when no handler matches", async () => {
    const req = { url: "/slack/other" } as IncomingMessage;
    const res = {} as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(false);
  });

  it("logs and ignores duplicate registrations", async () => {
    const handler = vi.fn();
    const log = vi.fn();
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/events",
        handler,
        log,
        accountId: "primary",
      }),
    );
    unregisters.push(
      registerSlackHttpHandler({
        path: "/slack/events",
        handler: vi.fn(),
        log,
        accountId: "duplicate",
      }),
    );

    const req = { url: "/slack/events" } as IncomingMessage;
    const res = {} as ServerResponse;

    const handled = await handleSlackHttpRequest(req, res);

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalledWith(req, res);
    expect(log).toHaveBeenCalledWith(
      'slack: webhook path /slack/events already registered for account "duplicate"',
    );
  });
});
