import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCommand = vi.fn();
const statusCommand = vi.fn();
const upCommand = vi.fn().mockResolvedValue({ server: undefined });
const webhookCommand = vi.fn().mockResolvedValue(undefined);
const ensureTwilioEnv = vi.fn();
const loginWeb = vi.fn();
const monitorWebProvider = vi.fn();
const pickProvider = vi.fn();
const monitorTwilio = vi.fn();
const logTwilioFrom = vi.fn();
const logWebSelfId = vi.fn();
const waitForever = vi.fn();
const spawnRelayTmux = vi.fn().mockResolvedValue("warelay-relay");

const runtime = {
	log: vi.fn(),
	error: vi.fn(),
	exit: vi.fn(() => {
		throw new Error("exit");
	}),
};

vi.mock("../commands/send.js", () => ({ sendCommand }));
vi.mock("../commands/status.js", () => ({ statusCommand }));
vi.mock("../commands/up.js", () => ({ upCommand }));
vi.mock("../commands/webhook.js", () => ({ webhookCommand }));
vi.mock("../env.js", () => ({ ensureTwilioEnv }));
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("../provider-web.js", () => ({
	loginWeb,
	monitorWebProvider,
	pickProvider,
}));
vi.mock("./deps.js", () => ({
	createDefaultDeps: () => ({ waitForever }),
	logTwilioFrom,
	logWebSelfId,
	monitorTwilio,
}));
vi.mock("./relay_tmux.js", () => ({ spawnRelayTmux }));

const { buildProgram } = await import("./program.js");

describe("cli program", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("runs send with required options", async () => {
		const program = buildProgram();
		await program.parseAsync(["send", "--to", "+1", "--message", "hi"], {
			from: "user",
		});
		expect(sendCommand).toHaveBeenCalled();
	});

	it("rejects invalid relay provider", async () => {
		const program = buildProgram();
		await expect(
			program.parseAsync(["relay", "--provider", "bogus"], { from: "user" }),
		).rejects.toThrow("exit");
		expect(runtime.error).toHaveBeenCalledWith(
			"--provider must be auto, web, or twilio",
		);
	});

	it("falls back to twilio when web relay fails", async () => {
		pickProvider.mockResolvedValue("web");
		monitorWebProvider.mockRejectedValue(new Error("no web"));
		const program = buildProgram();
		await program.parseAsync(
			["relay", "--provider", "auto", "--interval", "2", "--lookback", "1"],
			{ from: "user" },
		);
		expect(logWebSelfId).toHaveBeenCalled();
		expect(ensureTwilioEnv).toHaveBeenCalled();
		expect(monitorTwilio).toHaveBeenCalledWith(2, 1);
	});

	it("runs relay tmux attach command", async () => {
		const program = buildProgram();
		await program.parseAsync(["relay:tmux:attach"], { from: "user" });
		expect(spawnRelayTmux).toHaveBeenCalledWith(
			"pnpm warelay relay --verbose",
			true,
			false,
		);
	});
});
