import { describe, expect, it } from "vitest";

import * as impl from "../../provider-web.js";
import * as entry from "./index.js";

describe("providers/web entrypoint", () => {
	it("re-exports web provider helpers", () => {
		expect(entry.createWaSocket).toBe(impl.createWaSocket);
		expect(entry.loginWeb).toBe(impl.loginWeb);
		expect(entry.logWebSelfId).toBe(impl.logWebSelfId);
		expect(entry.monitorWebInbox).toBe(impl.monitorWebInbox);
		expect(entry.monitorWebProvider).toBe(impl.monitorWebProvider);
		expect(entry.pickProvider).toBe(impl.pickProvider);
		expect(entry.sendMessageWeb).toBe(impl.sendMessageWeb);
		expect(entry.WA_WEB_AUTH_DIR).toBe(impl.WA_WEB_AUTH_DIR);
		expect(entry.waitForWaConnection).toBe(impl.waitForWaConnection);
		expect(entry.webAuthExists).toBe(impl.webAuthExists);
	});
});
