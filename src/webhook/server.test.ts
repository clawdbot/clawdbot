import { describe, expect, it } from "vitest";

import * as impl from "../twilio/webhook.js";
import * as entry from "./server.js";

describe("webhook server wrapper", () => {
	it("re-exports startWebhook", () => {
		expect(entry.startWebhook).toBe(impl.startWebhook);
	});
});
