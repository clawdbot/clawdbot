import { describe, expect, it } from "vitest";

import * as impl from "../twilio/update-webhook.js";
import * as entry from "./update.js";

describe("webhook update wrappers", () => {
	it("mirror the Twilio implementations", () => {
		expect(entry.updateWebhook).toBe(impl.updateWebhook);
		expect(entry.findIncomingNumberSid).toBe(impl.findIncomingNumberSid);
		expect(entry.findMessagingServiceSid).toBe(impl.findMessagingServiceSid);
		expect(entry.setMessagingServiceWebhook).toBe(
			impl.setMessagingServiceWebhook,
		);
	});
});
