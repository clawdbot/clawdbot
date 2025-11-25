import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockTwilio } from "../test/mocks/twilio.js";
import { withWhatsAppPrefix } from "./utils.js";

// Twilio mock factory shared across tests
vi.mock("twilio", () => {
	const { factory } = createMockTwilio();
	return { default: factory };
});

type TwilioFactoryMock = ReturnType<typeof createMockTwilio>["factory"];
const twilioFactory = (await import("twilio")).default as TwilioFactoryMock;

import * as index from "./index.js";
import { splitMediaFromOutput } from "./media/parse.js";

const envBackup = { ...process.env } as Record<string, string | undefined>;

beforeEach(() => {
	process.env.TWILIO_ACCOUNT_SID = "AC123";
	process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+15551234567";
	process.env.TWILIO_AUTH_TOKEN = "token";
	delete process.env.TWILIO_API_KEY;
	delete process.env.TWILIO_API_SECRET;
	vi.clearAllMocks();
});

afterEach(() => {
	Object.entries(envBackup).forEach(([k, v]) => {
		if (v === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = v;
		}
	});
	vi.restoreAllMocks();
});

describe("command helpers", () => {
	it("runCommandWithTimeout captures stdout and timeout", async () => {
		const result = await index.runCommandWithTimeout(
			[process.execPath, "-e", "console.log('ok')"],
			500,
		);
		expect(result.stdout.trim()).toBe("ok");

		const slow = index.runCommandWithTimeout(
			[process.execPath, "-e", "setTimeout(()=>{}, 1000)"],
			20,
		);
		const timedOut = await slow;
		expect(timedOut.killed).toBe(true);
	});

	it("ensurePortAvailable rejects when in use", async () => {
		const server = net.createServer();
		await new Promise((resolve) => server.listen(0, resolve));
		const port = (server.address() as net.AddressInfo).port;
		await expect(index.ensurePortAvailable(port)).rejects.toBeInstanceOf(
			index.PortInUseError,
		);
		server.close();
	});
});

describe("config and templating", () => {
	it("getReplyFromConfig returns text when allowlist passes", async () => {
		const cfg = {
			inbound: {
				allowFrom: ["+1555"],
				reply: {
					mode: "text" as const,
					text: "Hello {{From}} {{Body}}",
					bodyPrefix: "[pfx] ",
				},
			},
		};

		const onReplyStart = vi.fn();
		const result = await index.getReplyFromConfig(
			{ Body: "hi", From: "whatsapp:+1555", To: "x" },
			{ onReplyStart },
			cfg,
		);
		expect(result?.text).toBe("Hello whatsapp:+1555 [pfx] hi");
		expect(onReplyStart).toHaveBeenCalled();
	});

	it("getReplyFromConfig templating includes media fields", async () => {
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["echo", "{{Body}}"],
				},
			},
		};
		const result = await index.getReplyFromConfig(
			{
				Body: "",
				From: "+1",
				To: "+2",
				MediaPath: "/tmp/a.jpg",
				MediaType: "image/jpeg",
				MediaUrl: "http://example.com/a.jpg",
			},
			undefined,
			cfg,
		);
		expect(result?.text).toContain("/tmp/a.jpg");
		expect(result?.text).toContain("image/jpeg");
		expect(result?.text).toContain("http://example.com/a.jpg");
	});

	it("getReplyFromConfig extracts media URL from command stdout", async () => {
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: "hello\nMEDIA: https://example.com/img.jpg\n",
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["echo", "{{Body}}"],
				},
			},
		};
		const result = await index.getReplyFromConfig(
			{
				Body: "hi",
				From: "+1",
				To: "+2",
			},
			undefined,
			cfg,
			runSpy,
		);
		expect(result?.text).toBe("hello");
		expect(result?.mediaUrl).toBe("https://example.com/img.jpg");
	});

	it("extracts first MEDIA token even with trailing text", async () => {
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: "hello\nMEDIA:/tmp/pic.png extra words here\n",
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["echo", "{{Body}}"],
				},
			},
		};
		const result = await index.getReplyFromConfig(
			{ Body: "hi", From: "+1", To: "+2" },
			undefined,
			cfg,
			runSpy,
		);
		expect(result?.mediaUrl).toBe("/tmp/pic.png");
	});

	it("extracts MEDIA token inline within a sentence", async () => {
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: "caption before MEDIA:/tmp/pic.png caption after",
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["echo", "{{Body}}"],
				},
			},
		};
		const result = await index.getReplyFromConfig(
			{ Body: "hi", From: "+1", To: "+2" },
			undefined,
			cfg,
			runSpy,
		);
		expect(result?.mediaUrl).toBe("/tmp/pic.png");
		expect(result?.text).toBe("caption before caption after");
	});

	it("captures MEDIA wrapped in backticks", async () => {
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: "MEDIA:`/tmp/pic.png` cool",
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["echo", "{{Body}}"],
				},
			},
		};
		const result = await index.getReplyFromConfig(
			{ Body: "hi", From: "+1", To: "+2" },
			undefined,
			cfg,
			runSpy,
		);
		expect(result?.mediaUrl).toBe("/tmp/pic.png");
	});

	it("captures MEDIA token with trailing JSON characters", async () => {
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: 'MEDIA:/tmp/pic.png"} trailing',
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["echo", "{{Body}}"],
				},
			},
		};
		const result = await index.getReplyFromConfig(
			{ Body: "hi", From: "+1", To: "+2" },
			undefined,
			cfg,
			runSpy,
		);
		expect(result?.mediaUrl).toBe("/tmp/pic.png");
	});

	it("ignores invalid MEDIA lines with whitespace", async () => {
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: "hello\nMEDIA: not a url with spaces\nrest\n",
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["echo", "{{Body}}"],
				},
			},
		};
		const result = await index.getReplyFromConfig(
			{ Body: "hi", From: "+1", To: "+2" },
			undefined,
			cfg,
			runSpy,
		);
		expect(result?.text).toBe("hello\nrest");
		expect(result?.mediaUrl).toBeUndefined();
	});

	it("injects fallback text when command returns nothing", async () => {
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: "",
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["echo", "{{Body}}"],
				},
			},
		};
		const result = await index.getReplyFromConfig(
			{ Body: "hi", From: "+1", To: "+2" },
			undefined,
			cfg,
			runSpy,
		);
		expect(result?.text).toContain("command produced no output");
		expect(result?.mediaUrl).toBeUndefined();
	});

	it("splitMediaFromOutput strips media token and preserves text", () => {
		const { text, mediaUrl } = splitMediaFromOutput(
			"line1\nMEDIA:https://x/y.png\nline2",
		);
		expect(mediaUrl).toBe("https://x/y.png");
		expect(text).toBe("line1\nline2");
	});

	it("getReplyFromConfig runs command and manages session store", async () => {
		const tmpStore = path.join(os.tmpdir(), `warelay-store-${Date.now()}.json`);
		vi.spyOn(crypto, "randomUUID").mockReturnValue("session-123");
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: "cmd output\n",
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["echo", "{{Body}}"],
					template: "[tmpl]",
					session: {
						scope: "per-sender" as const,
						resetTriggers: ["/new"],
						store: tmpStore,
						sessionArgNew: ["--sid", "{{SessionId}}"],
						sessionArgResume: ["--resume", "{{SessionId}}"],
					},
				},
			},
		};

		const first = await index.getReplyFromConfig(
			{ Body: "/new hello", From: "+1555", To: "+1666" },
			undefined,
			cfg,
			runSpy,
		);
			expect(first?.text).toBe("cmd output");
		const argvFirst = runSpy.mock.calls[0][0];
		expect(argvFirst).toEqual([
			"echo",
			"[tmpl]",
			"--sid",
			"session-123",
			"hello",
		]);

		const second = await index.getReplyFromConfig(
			{ Body: "next", From: "+1555", To: "+1666" },
			undefined,
			cfg,
			runSpy,
		);
			expect(second?.text).toBe("cmd output");
		const argvSecond = runSpy.mock.calls[1][0];
		expect(argvSecond[2]).toBe("--resume");
	});

	it("injects Claude output format + print flag when configured", async () => {
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: "ok",
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["claude", "{{Body}}"],
					claudeOutputFormat: "text" as const,
				},
			},
		};

		await index.getReplyFromConfig(
			{ Body: "hi", From: "+1555", To: "+1666" },
			undefined,
			cfg,
			runSpy,
		);

		const argv = runSpy.mock.calls[0][0];
		expect(argv[0]).toBe("claude");
		expect(argv.at(-1)).toContain("You are Clawd (Claude)");
		expect(argv.at(-1)).toContain("/Users/steipete/clawd");
		expect(argv.at(-1)).toMatch(/hi$/);
		// The helper should auto-add print and output format flags without disturbing the prompt position.
		expect(argv.includes("-p") || argv.includes("--print")).toBe(true);
		const outputIdx = argv.findIndex(
			(part) =>
				part === "--output-format" || part.startsWith("--output-format="),
		);
		expect(outputIdx).toBeGreaterThan(-1);
		expect(argv[outputIdx + 1]).toBe("text");
	});

	it("parses Claude JSON output and returns text content", async () => {
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: '{"text":"hello world"}\n',
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["claude", "{{Body}}"],
					claudeOutputFormat: "json" as const,
				},
			},
		};

			const result = await index.getReplyFromConfig(
				{ Body: "hi", From: "+1", To: "+2" },
				undefined,
				cfg,
				runSpy,
			);

			expect(result?.text).toBe("hello world");
		});

	it("parses Claude JSON output even without explicit claudeOutputFormat when using claude bin", async () => {
		const runSpy = vi.spyOn(index, "runCommandWithTimeout").mockResolvedValue({
			stdout: '{"result":"Sure! What\'s up?"}\n',
			stderr: "",
			code: 0,
			signal: null,
			killed: false,
		});
		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["claude", "{{Body}}"],
					// No claudeOutputFormat set on purpose
				},
			},
		};

			const result = await index.getReplyFromConfig(
				{ Body: "hi", From: "+1", To: "+2" },
				undefined,
				cfg,
				runSpy,
			);

			expect(result?.text).toBe("Sure! What's up?");
			const argv = runSpy.mock.calls[0][0];
			expect(argv.at(-1)).toContain("You are Clawd (Claude)");
			expect(argv.at(-1)).toContain("/Users/steipete/clawd");
	});

	it("serializes command auto-replies via the queue", async () => {
		let active = 0;
		let maxActive = 0;
		const runSpy = vi.fn(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			active -= 1;
			return {
				stdout: "ok",
				stderr: "",
				code: 0,
				signal: null,
				killed: false,
			};
		});

		const cfg = {
			inbound: {
				reply: {
					mode: "command" as const,
					command: ["echo", "{{Body}}"],
				},
			},
		};

		await Promise.all([
			index.getReplyFromConfig(
				{ Body: "first", From: "+1", To: "+2" },
				undefined,
				cfg,
				runSpy,
			),
			index.getReplyFromConfig(
				{ Body: "second", From: "+3", To: "+4" },
				undefined,
				cfg,
				runSpy,
			),
		]);

		expect(runSpy).toHaveBeenCalledTimes(2);
		expect(maxActive).toBe(1);
	});
});

describe("twilio interactions", () => {
	it("autoReplyIfConfigured sends message when configured", async () => {
		const client = twilioFactory._createClient();
		client.messages.create.mockResolvedValue({});
		await index.autoReplyIfConfigured(
			client,
			{
				from: "whatsapp:+1",
				to: "whatsapp:+2",
				body: "hi",
				sid: "SM1",
			} as unknown as MessageInstance,
			{
				inbound: {
					reply: { mode: "text", text: "auto-text" },
				},
			},
		);

		expect(client.messages.create).toHaveBeenCalledWith({
			from: "whatsapp:+2",
			to: "whatsapp:+1",
			body: "auto-text",
		});
	});

	it("sendTypingIndicator skips missing messageSid and sends when present", async () => {
		const client = twilioFactory._createClient();
		await index.sendTypingIndicator(client, index.defaultRuntime, undefined);
		expect(client.request).not.toHaveBeenCalled();

		await index.sendTypingIndicator(client, index.defaultRuntime, "SM123");
		expect(client.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: "post" }),
		);
	});

	it("sendMessage wraps Twilio client and returns sid", async () => {
		const client = twilioFactory._createClient();
		client.messages.create.mockResolvedValue({ sid: "SM999" });
		twilioFactory.mockReturnValue(client);

		const result = await index.sendMessage("+1555", "hi");
		expect(client.messages.create).toHaveBeenCalledWith({
			from: withWhatsAppPrefix("whatsapp:+15551234567"),
			to: withWhatsAppPrefix("+1555"),
			body: "hi",
		});
		expect(result?.sid).toBe("SM999");
	});

	it("waitForFinalStatus resolves on delivered", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce({ status: "sent" })
			.mockResolvedValueOnce({ status: "delivered" });
		const client = {
			messages: vi.fn(() => ({ fetch })),
		};
		await index.waitForFinalStatus(
			client as unknown as ReturnType<typeof index.createClient>,
			"SM1",
			1,
			0,
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("waitForFinalStatus exits on failure", async () => {
		const runtime: index.RuntimeEnv = {
			error: vi.fn(),
			exit: vi.fn() as unknown as (code: number) => never,
			log: console.log,
		};
		const fetch = vi.fn().mockResolvedValue({ status: "failed" });
		const client = {
			messages: vi.fn(() => ({ fetch })),
		};
		await index
			.waitForFinalStatus(
				client as unknown as ReturnType<typeof index.createClient>,
				"SM2",
				1,
				0,
				runtime,
			)
			.catch(() => {});
		expect(runtime.exit).toHaveBeenCalledWith(1);
	});
});

describe("webhook and messaging", () => {
	it("startWebhook responds and auto-replies", async () => {
		const client = twilioFactory._createClient();
		client.messages.create.mockResolvedValue({});
		twilioFactory.mockReturnValue(client);
		vi.spyOn(index, "getReplyFromConfig").mockResolvedValue({ text: "Auto" });

		const server = await index.startWebhook(0, "/hook", undefined, false);
		const address = server.address() as net.AddressInfo;
		const url = `http://127.0.0.1:${address.port}/hook`;
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "From=whatsapp%3A%2B1555&To=whatsapp%3A%2B1666&Body=Hello&MessageSid=SM2",
		});
		expect(res.status).toBe(200);
		await new Promise((resolve) => server.close(resolve));
	});

	it("hosts local media before replying via webhook", async () => {
		const client = twilioFactory._createClient();
		client.messages.create.mockResolvedValue({});
		twilioFactory.mockReturnValue(client);
		const replies = await import("./auto-reply/reply.js");
		const hostModule = await import("./media/host.js");
		const hostSpy = vi
			.spyOn(hostModule, "ensureMediaHosted")
			.mockResolvedValue({ url: "https://ts.net/media/abc", id: "abc", size: 123 });
		vi.spyOn(replies, "getReplyFromConfig").mockResolvedValue({
			text: "Auto",
			mediaUrl: "/tmp/pic.png",
		});

		const server = await index.startWebhook(0, "/hook", undefined, false);
		const address = server.address() as net.AddressInfo;
		const url = `http://127.0.0.1:${address.port}/hook`;
		await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "From=whatsapp%3A%2B1555&To=whatsapp%3A%2B1666&Body=Hello&MessageSid=SM2",
		});

		expect(hostSpy).toHaveBeenCalledWith("/tmp/pic.png");
		expect(client.messages.create).toHaveBeenCalledWith(
			expect.objectContaining({
				mediaUrl: ["https://ts.net/media/abc"],
			}),
		);
		hostSpy.mockRestore();
		await new Promise((resolve) => server.close(resolve));
	});

	it("listRecentMessages merges and sorts", async () => {
		const inbound = [
			{
				sid: "1",
				status: "delivered",
				direction: "inbound",
				dateCreated: new Date("2024-01-01T00:00:00Z"),
				from: "a",
				to: "b",
				body: "hi",
				errorCode: null,
				errorMessage: null,
			},
		];
		const outbound = [
			{
				sid: "2",
				status: "sent",
				direction: "outbound-api",
				dateCreated: new Date("2024-01-02T00:00:00Z"),
				from: "b",
				to: "a",
				body: "yo",
				errorCode: null,
				errorMessage: null,
			},
		];
		const client = twilioFactory._createClient();
		client.messages.list
			.mockResolvedValueOnce(inbound)
			.mockResolvedValueOnce(outbound);

		const messages = await index.listRecentMessages(60, 5, client);
		expect(messages[0].sid).toBe("2");
		expect(messages).toHaveLength(2);
	});

	it("formatMessageLine builds readable string", () => {
		const line = index.formatMessageLine({
			sid: "SID",
			status: "delivered",
			direction: "inbound",
			dateCreated: new Date("2024-01-01T00:00:00Z"),
			from: "a",
			to: "b",
			body: "hello world",
			errorCode: null,
			errorMessage: null,
		});
		expect(line).toContain("SID");
		expect(line).toContain("hello world");
	});
});

describe("sender discovery", () => {
	it("findWhatsappSenderSid prefers explicit env", async () => {
		const client = twilioFactory._createClient();
		const sid = await index.findWhatsappSenderSid(client, "+1555", "SID123");
		expect(sid).toBe("SID123");
	});

	it("findWhatsappSenderSid lists senders when needed", async () => {
		const client = twilioFactory._createClient();
		client.messaging.v2.channelsSenders.list.mockResolvedValue([
			{ sender_id: withWhatsAppPrefix("+1555"), sid: "S1" },
		]);
		const sid = await index.findWhatsappSenderSid(client, "+1555");
		expect(sid).toBe("S1");
	});

	it("updateWebhook uses primary update path", async () => {
		const fetched = { webhook: { callback_url: "https://cb" } };
		const client = {
			request: vi.fn().mockResolvedValue({}),
			messaging: {
				v2: {
					channelsSenders: vi.fn(() => ({
						fetch: vi.fn().mockResolvedValue(fetched),
					})),
				},
				v1: { services: vi.fn(() => ({ update: vi.fn(), fetch: vi.fn() })) },
			},
			incomingPhoneNumbers: vi.fn(),
		} as unknown as ReturnType<typeof index.createClient>;

		await index.updateWebhook(client, "SID", "https://example.com", "POST");
		expect(client.request).toHaveBeenCalled();
	});
});

describe("infra helpers", () => {
	it("handlePortError prints owner details", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("exit");
		}) as () => never);
		vi.spyOn(index, "describePortOwner").mockResolvedValue("proc listening");
		await expect(
			index.handlePortError(new index.PortInUseError(1234), 1234, "Context"),
		).rejects.toThrow("exit");
		expect(exitSpy).toHaveBeenCalled();
	});

	it("getTailnetHostname prefers DNS then IP", async () => {
		type ExecFn = (
			command: string,
			args?: string[],
			options?: unknown,
		) => Promise<{ stdout: string; stderr: string }>;
		const exec: ExecFn = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ Self: { DNSName: "host.tailnet." } }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ Self: { TailscaleIPs: ["100.1.2.3"] } }),
				stderr: "",
			});
		const dns = await index.getTailnetHostname(exec);
		expect(dns).toBe("host.tailnet");
		const ip = await index.getTailnetHostname(exec);
		expect(ip).toBe("100.1.2.3");
	});

	it("ensureGoInstalled installs when missing", async () => {
		const exec = vi
			.fn<
				index.CommandArgs | index.CommandArgsWithOptions,
				Promise<{ stdout: string; stderr: string }>
			>()
			.mockRejectedValueOnce(new Error("missing"))
			.mockResolvedValue({ stdout: "", stderr: "" });
		const prompt = vi.fn<[], Promise<boolean>>().mockResolvedValue(true);
		await index.ensureGoInstalled(exec, prompt);
		expect(exec).toHaveBeenCalledWith("brew", ["install", "go"]);
	});

	it("ensureTailscaledInstalled installs when missing", async () => {
		const exec = vi
			.fn<
				index.CommandArgs | index.CommandArgsWithOptions,
				Promise<{ stdout: string; stderr: string }>
			>()
			.mockRejectedValueOnce(new Error("missing"))
			.mockResolvedValue({ stdout: "", stderr: "" });
		const prompt = vi.fn<[], Promise<boolean>>().mockResolvedValue(true);
		await index.ensureTailscaledInstalled(exec, prompt);
		expect(exec).toHaveBeenCalledWith("brew", ["install", "tailscale"]);
	});

	it("ensureFunnel enables funnel when status present", async () => {
		const exec = vi
			.fn<
				index.CommandArgs | index.CommandArgsWithOptions,
				Promise<{ stdout: string; stderr: string }>
			>()
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ Enabled: true }),
				stderr: "",
			})
			.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
		await index.ensureFunnel(8080, exec);
		expect(exec).toHaveBeenCalledTimes(2);
	});
});

describe("twilio helpers", () => {
	it("findIncomingNumberSid and messaging sid helpers", async () => {
		const client = twilioFactory._createClient();
		client.incomingPhoneNumbers.list.mockResolvedValue([
			{ sid: "PN1", messagingServiceSid: "MG1" },
		]);
		const sid = await index.findIncomingNumberSid(client);
		expect(sid).toBe("PN1");
		const msid = await index.findMessagingServiceSid(client);
		expect(msid).toBe("MG1");
	});

	it("setMessagingServiceWebhook updates service", async () => {
		const updater = { update: vi.fn().mockResolvedValue({}), fetch: vi.fn() };
		const client = twilioFactory._createClient();
		client.messaging.v1.services.mockReturnValue(
			updater as unknown as ReturnType<typeof client.messaging.v1.services>,
		);
		client.incomingPhoneNumbers.list.mockResolvedValue([
			{ messagingServiceSid: "MS1" },
		]);
		const updated = await index.setMessagingServiceWebhook(
			client,
			"https://x",
			"POST",
		);
		expect(updated).toBe(true);
		expect(updater.update).toHaveBeenCalled();
	});

	it("uniqueBySid and sortByDateDesc de-dupe and order", () => {
		const messages = [
			{ sid: "1", dateCreated: new Date("2023-01-01") },
			{ sid: "1", dateCreated: new Date("2023-01-02") },
			{ sid: "2", dateCreated: new Date("2024-01-01") },
		];
		const unique = index.uniqueBySid(messages);
		expect(unique).toHaveLength(2);
		const sorted = index.sortByDateDesc(unique);
		expect(sorted[0].sid).toBe("2");
	});

	it("formatTwilioError and logTwilioSendError include details", () => {
		const runtime: index.RuntimeEnv = {
			error: vi.fn(),
			log: vi.fn(),
			exit: ((code: number) => {
				throw new Error(`exit ${code}`);
			}) as (code: number) => never,
		};
		const errString = index.formatTwilioError({
			code: 123,
			status: 400,
			message: "bad",
			moreInfo: "link",
		});
		expect(errString).toContain("123");
		index.logTwilioSendError({ response: { body: { x: 1 } } }, "+1", runtime);
		expect(runtime.error).toHaveBeenCalled();
	});

	it("logTwilioSendError handles error without response", () => {
		const runtime: index.RuntimeEnv = {
			error: vi.fn(),
			log: vi.fn(),
			exit: ((code: number) => {
				throw new Error(`exit ${code}`);
			}) as (code: number) => never,
		};
		index.logTwilioSendError(new Error("oops"), undefined, runtime);
		expect(runtime.error).toHaveBeenCalled();
	});
});

describe("monitoring", () => {
	it("monitorTwilio polls once and processes inbound", async () => {
		const client = {
			messages: {
				list: vi.fn().mockResolvedValue([
					{
						sid: "m1",
						direction: "inbound",
						dateCreated: new Date(),
						from: "+1",
						to: "+2",
						body: "hi",
					},
				]),
			},
		} as unknown as ReturnType<typeof index.createClient>;
		vi.spyOn(index, "getReplyFromConfig").mockResolvedValue(undefined);
		await index.monitorTwilio(0, 0, client, 1);
		expect(client.messages.list).toHaveBeenCalled();
	});

	it("ensureFunnel failure path exits via runtime", async () => {
		const runtime: index.RuntimeEnv = {
			error: vi.fn(),
			exit: vi.fn() as unknown as (code: number) => never,
			log: console.log,
		};
		const exec = vi.fn().mockRejectedValue({ stdout: "Funnel is not enabled" });
		await index.ensureFunnel(8080, exec, runtime).catch(() => {});
		expect(runtime.error).toHaveBeenCalled();
		expect(runtime.exit).toHaveBeenCalledWith(1);
	});

		it("monitorWebProvider triggers replies and stops when asked", async () => {
			const replySpy = vi.fn();
			const sendMediaSpy = vi.fn();
			const listenerFactory = vi.fn(
				async (
					opts: Parameters<typeof index.monitorWebProvider>[1] extends undefined
						? never
						: NonNullable<Parameters<typeof index.monitorWebProvider>[1]>,
				) => {
					await opts.onMessage({
						body: "hello",
						from: "+1",
						to: "+2",
						id: "id1",
						sendComposing: vi.fn(),
						reply: replySpy,
						sendMedia: sendMediaSpy,
					});
					return { close: vi.fn() };
				},
			);
			const resolver = vi.fn().mockResolvedValue({ text: "auto" });
			await index.monitorWebProvider(false, listenerFactory, false, resolver);
			expect(replySpy).toHaveBeenCalledWith("auto");
		});
	});
