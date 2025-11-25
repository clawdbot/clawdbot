import { success } from "../globals.js";
import { logInfo } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { withWhatsAppPrefix, sleep } from "../utils.js";
import { readEnv } from "../env.js";
import { createClient } from "./client.js";
import { logTwilioSendError } from "./utils.js";

const successTerminalStatuses = new Set(["delivered", "read"]);
const failureTerminalStatuses = new Set(["failed", "undelivered", "canceled"]);

// Send outbound WhatsApp message; exit non-zero on API failure.
export async function sendMessage(
	to: string,
	body: string,
	opts?: { mediaUrl?: string },
	runtime: RuntimeEnv = defaultRuntime,
) {
	const env = readEnv(runtime);
	const client = createClient(env);
	const from = withWhatsAppPrefix(env.whatsappFrom);
	const toNumber = withWhatsAppPrefix(to);

	try {
		const message = await client.messages.create({
			from,
			to: toNumber,
			body,
			mediaUrl: opts?.mediaUrl ? [opts.mediaUrl] : undefined,
		});

		logInfo(`✅ Request accepted. Message SID: ${message.sid} -> ${toNumber}`, runtime);
		return { client, sid: message.sid };
	} catch (err) {
		logTwilioSendError(err, toNumber, runtime);
	}
}

// Poll message status until delivered/failed or timeout.
export async function waitForFinalStatus(
	client: ReturnType<typeof createClient>,
	sid: string,
	timeoutSeconds: number,
	pollSeconds: number,
	runtime: RuntimeEnv = defaultRuntime,
) {
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		const m = await client.messages(sid).fetch();
		const status = m.status ?? "unknown";
		if (successTerminalStatuses.has(status)) {
			logInfo(`✅ Delivered (status: ${status})`, runtime);
			return;
		}
		if (failureTerminalStatuses.has(status)) {
			runtime.error(
				`❌ Delivery failed (status: ${status}${m.errorCode ? `, code ${m.errorCode}` : ""})${m.errorMessage ? `: ${m.errorMessage}` : ""}`,
			);
			runtime.exit(1);
		}
		await sleep(pollSeconds * 1000);
	}
	logInfo(
		"ℹ️  Timed out waiting for final status; message may still be in flight.",
		runtime,
	);
}
