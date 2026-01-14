import { describe, expect, it } from "vitest";

import * as impl from "../../channel-web.js";
import * as entry from "./index.js";

describe("channels/web entrypoint", () => {
  it("re-exports web channel helpers", () => {
    expect(entry.createWaSocket).toBe(impl.createWaSocket);
    expect(entry.loginWeb).toBe(impl.loginWeb);
    expect(entry.logWebSelfId).toBe(impl.logWebSelfId);
    expect(entry.monitorWebInbox).toBe(impl.monitorWebInbox);
    expect(entry.monitorWebChannel).toBe(impl.monitorWebChannel);
    expect(entry.pickWebChannel).toBe(impl.pickWebChannel);
    expect(entry.sendMessageWhatsApp).toBe(impl.sendMessageWhatsApp);
    expect(entry.WA_WEB_AUTH_DIR).toBe(impl.WA_WEB_AUTH_DIR);
    expect(entry.waitForWaConnection).toBe(impl.waitForWaConnection);
    expect(entry.webAuthExists).toBe(impl.webAuthExists);
  });
});
