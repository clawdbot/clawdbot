import { describe, expect, it, vi } from "vitest";

import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { upCommand } from "./up.js";

const runtime: RuntimeEnv = {
	log: vi.fn(),
	error: vi.fn(),
	exit: vi.fn(() => {
		throw new Error("exit");
	}),
};

const makeDeps = (): CliDeps => ({
	ensurePortAvailable: vi.fn().mockResolvedValue(undefined),
	readEnv: vi.fn().mockReturnValue({
		whatsappFrom: "whatsapp:+1555",
		whatsappSenderSid: "WW",
	}),
	ensureBinary: vi.fn().mockResolvedValue(undefined),
	ensureFunnel: vi.fn().mockResolvedValue(undefined),
	getTailnetHostname: vi.fn().mockResolvedValue("tailnet-host"),
	startWebhook: vi.fn().mockResolvedValue({ server: true }),
	createClient: vi.fn().mockReturnValue({ client: true }),
	findWhatsappSenderSid: vi.fn().mockResolvedValue("SID123"),
	updateWebhook: vi.fn().mockResolvedValue(undefined),
});

describe("upCommand", () => {
	it("throws on invalid port", async () => {
		await expect(() =>
			upCommand({ port: "0", path: "/cb" }, makeDeps(), runtime),
		).rejects.toThrow("Port must be between 1 and 65535");
	});

	it("performs dry run and returns mock data", async () => {
		runtime.log.mockClear();
		const result = await upCommand(
			{ port: "42873", path: "/cb", dryRun: true },
			makeDeps(),
			runtime,
		);
		expect(runtime.log).toHaveBeenCalledWith(
			"[dry-run] would enable funnel on port 42873",
		);
		expect(result?.publicUrl).toBe("https://dry-run/cb");
		expect(result?.senderSid).toBeUndefined();
	});

	it("enables funnel, starts webhook, and updates Twilio", async () => {
		const deps = makeDeps();
		const res = await upCommand(
			{ port: "42873", path: "/hook", verbose: true },
			deps,
			runtime,
		);
		expect(deps.ensureBinary).toHaveBeenCalledWith(
			"tailscale",
			undefined,
			runtime,
		);
		expect(deps.ensureFunnel).toHaveBeenCalled();
		expect(deps.startWebhook).toHaveBeenCalled();
		expect(deps.updateWebhook).toHaveBeenCalledWith(
			expect.anything(),
			"SID123",
			"https://tailnet-host/hook",
			"POST",
			runtime,
		);
		expect(res?.publicUrl).toBe("https://tailnet-host/hook");
		// waiter is returned to keep the process alive in real use.
		expect(typeof res?.waiter).toBe("function");
	});
});
