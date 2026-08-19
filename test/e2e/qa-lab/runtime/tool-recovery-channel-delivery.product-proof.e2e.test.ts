import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
  startQaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import { getFreePort } from "../../../../src/test-utils/ports.js";

const RECOVERY_MARKER = "OPENCLAW_E2E_EDIT_FAILURE_MATCHED_RETRY";
const FINAL_MARKER = `${RECOVERY_MARKER}_FINAL`;
const FIXTURE_PATH = "issue-46548-edit-recovery.txt";
const TIMEOUT_MS = 120_000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .toReversed()
      .map((cleanup) => cleanup()),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "tool recovery delivery proof cleanup failed");
  }
});

async function startEditRecoveryProvider(repoRoot: string) {
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, "scripts/e2e/mock-openai-server.mjs")],
    {
      cwd: repoRoot,
      env: { ...process.env, MOCK_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const appendOutput = (chunk: Buffer | string) => {
    output = `${output}${String(chunk)}`.slice(-16_000);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);
  const deadline = Date.now() + 10_000;
  while (!output.includes(`mock-openai listening on ${port}`)) {
    if (child.exitCode !== null) {
      throw new Error(`edit recovery provider exited early (${child.exitCode}): ${output}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`edit recovery provider did not start: ${output}`);
    }
    await sleep(25);
  }
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "exit"),
        sleep(5_000, undefined, { ref: false }).then(() => {
          child.kill("SIGKILL");
        }),
      ]);
    },
  };
}

async function waitForRecoveryDelivery(state: ReturnType<typeof createQaBusState>, cursor: number) {
  await state.waitForCursorAdvance(cursor, TIMEOUT_MS, (snapshot) => {
    const text = snapshot.messages
      .slice(cursor)
      .filter((message) => message.direction === "outbound")
      .map((message) => message.text)
      .join("\n");
    return text.includes(FINAL_MARKER) && text.includes("Edit succeeded after retry");
  });
  const outbound = state
    .getSnapshot()
    .messages.slice(cursor)
    .filter((message) => message.direction === "outbound");
  return { outbound, text: outbound.map((message) => message.text).join("\n") };
}

describe.runIf(process.env.OPENCLAW_TOOL_RECOVERY_CHANNEL_PROOF === "1")(
  "tool recovery channel delivery product proof",
  () => {
    it(
      "delivers a redacted recovery receipt through the gateway and qa-channel",
      { timeout: TIMEOUT_MS + 30_000 },
      async () => {
        const repoRoot = process.cwd();
        const provider = await startEditRecoveryProvider(repoRoot);
        cleanups.push(() => provider.stop());
        const state = createQaBusState();
        const bus = await startQaBusServer({ state });
        cleanups.push(() => bus.stop());
        const gateway = await startQaGatewayChild({
          repoRoot,
          useRepoCli: true,
          providerBaseUrl: `${provider.baseUrl}/v1`,
          providerMode: "mock-openai",
          transport: createQaChannelTransport(state),
          transportBaseUrl: bus.baseUrl,
          enabledPluginIds: ["qa-lab"],
          controlUiEnabled: false,
        });
        cleanups.push(() => gateway.stop());

        const cursor = state.getSnapshot().messages.length;
        state.addInboundMessage({
          conversation: { id: "tool-recovery-proof", kind: "direct" },
          senderId: "tool-recovery-proof",
          senderName: "Tool Recovery Proof",
          text: `Run ${RECOVERY_MARKER}.`,
        });
        const delivery = await waitForRecoveryDelivery(state, cursor);

        expect(delivery.text).toContain(FINAL_MARKER);
        expect(delivery.text).toContain("✅ 📝 Edit succeeded after retry.");
        expect(delivery.text).not.toContain(FIXTURE_PATH);
        expect(delivery.text).not.toContain("Could not find the exact text");
        expect(delivery.outbound.every((message) => message.isError !== true)).toBe(true);
      },
    );
  },
);
