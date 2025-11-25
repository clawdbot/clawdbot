import { warn, isVerbose, logVerbose } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";

type TwilioRequestOptions = {
	method: "get" | "post";
	uri: string;
	params?: Record<string, string | number>;
	form?: Record<string, string>;
	body?: unknown;
	contentType?: string;
};

type TwilioRequester = {
	request: (options: TwilioRequestOptions) => Promise<unknown>;
};

export async function sendTypingIndicator(
	client: TwilioRequester,
	messageSid?: string,
	runtime: RuntimeEnv,
) {
	// Best-effort WhatsApp typing indicator (public beta as of Nov 2025).
	if (!messageSid) {
		logVerbose("Skipping typing indicator: missing MessageSid");
		return;
	}
	try {
		await client.request({
			method: "post",
			uri: "https://messaging.twilio.com/v2/Indicators/Typing.json",
			form: {
				messageId: messageSid,
				channel: "whatsapp",
			},
		});
		logVerbose(`Sent typing indicator for inbound ${messageSid}`);
	} catch (err) {
		if (isVerbose()) {
			runtime.error(warn("Typing indicator failed (continuing without it)"));
			runtime.error(err as Error);
		}
	}
}
