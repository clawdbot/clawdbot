import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("chat steer styles", () => {
  it("styles queued-message steering controls and pending indicators", () => {
    const cssPath = [
      resolve(process.cwd(), "src/styles/chat/layout.css"),
      resolve(process.cwd(), "ui/src/styles/chat/layout.css"),
    ].find((candidate) => existsSync(candidate));
    expect(cssPath).toBeTruthy();
    const css = readFileSync(cssPath!, "utf8");

    expect(css).toContain(".chat-queue__steer");
    expect(css).toContain(".chat-queue__actions");
    expect(css).toContain(".chat-queue__item--steered");
    expect(css).toContain(".chat-queue__badge");
  });
});
