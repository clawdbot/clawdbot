import { describe, expect, it } from "vitest";

import * as mod from "./channel-web.js";

describe("channel-web barrel", () => {
  it("exports the expected web helpers", () => {
    expect(mod.createWaSocket).toBeTypeOf("function");
    expect(mod.loginWeb).toBeTypeOf("function");
    expect(mod.monitorWebChannel).toBeTypeOf("function");
    expect(mod.sendMessageWhatsApp).toBeTypeOf("function");
    expect(mod.monitorWebInbox).toBeTypeOf("function");
    expect(mod.pickWebChannel).toBeTypeOf("function");
    expect(mod.WA_WEB_AUTH_DIR).toBeTruthy();
  });
});
