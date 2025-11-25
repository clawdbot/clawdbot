import { info } from "../globals.js";
import type { CliDeps } from "../cli/deps.js";
import type { Provider } from "../utils.js";
import type { RuntimeEnv } from "../runtime.js";

export async function sendCommand(
	opts: {
		to: string;
		message: string;
		wait: string;
		poll: string;
		provider: Provider;
		json?: boolean;
		dryRun?: boolean;
		media?: string;
		serveMedia?: boolean;
	},
	deps: CliDeps,
	runtime: RuntimeEnv,
) {
	deps.assertProvider(opts.provider);
	const waitSeconds = Number.parseInt(opts.wait, 10);
	const pollSeconds = Number.parseInt(opts.poll, 10);

	if (Number.isNaN(waitSeconds) || waitSeconds < 0) {
		throw new Error("Wait must be >= 0 seconds");
	}
	if (Number.isNaN(pollSeconds) || pollSeconds <= 0) {
		throw new Error("Poll must be > 0 seconds");
	}

	if (opts.provider === "web") {
		if (opts.dryRun) {
			runtime.log(
				`[dry-run] would send via web -> ${opts.to}: ${opts.message}${opts.media ? ` (media ${opts.media})` : ""}`,
			);
			return;
		}
		if (waitSeconds !== 0) {
			runtime.log(info("Wait/poll are Twilio-only; ignored for provider=web."));
		}
		const res = await deps.sendMessageWeb(
			opts.to,
			opts.message,
			{
				verbose: false,
				mediaUrl: opts.media,
			},
		);
		if (opts.json) {
			runtime.log(
				JSON.stringify(
					{
						provider: "web",
						to: opts.to,
						messageId: res.messageId,
						mediaUrl: opts.media ?? null,
					},
					null,
					2,
				),
			);
		}
		return;
	}

	if (opts.dryRun) {
		runtime.log(
			`[dry-run] would send via twilio -> ${opts.to}: ${opts.message}${opts.media ? ` (media ${opts.media})` : ""}`,
		);
		return;
	}

	let mediaUrl: string | undefined = undefined;
	if (opts.media) {
		mediaUrl = await deps.resolveTwilioMediaUrl(opts.media, {
			serveMedia: Boolean(opts.serveMedia),
			runtime,
		});
	}

	const result = await deps.sendMessage(
		opts.to,
		opts.message,
		{ mediaUrl },
		runtime,
	);
	if (opts.json) {
		runtime.log(
			JSON.stringify(
				{
					provider: "twilio",
					to: opts.to,
					sid: result?.sid ?? null,
					mediaUrl: mediaUrl ?? null,
				},
				null,
				2,
			),
		);
	}
	if (!result) return;
	if (waitSeconds === 0) return;
	await deps.waitForFinalStatus(
		result.client,
		result.sid,
		waitSeconds,
		pollSeconds,
		runtime,
	);
}
