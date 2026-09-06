import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it, vi } from "vitest";
import {
  buildNotifyMessageUpsert,
  installWebMonitorInboxUnitTestHooks,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

installWebMonitorInboxUnitTestHooks();

it("updates WhatsApp timing and drains batches enabled after socket attachment", async () => {
  let cfg: OpenClawConfig = {
    channels: { whatsapp: { allowFrom: ["*"] } },
    messages: { inbound: { debounceMs: 0 } },
  };
  const onMessage = vi.fn<InboxOnMessage>(async () => {});
  const { listener, sock } = await startInboxMonitor(onMessage, { cfg, loadConfig: () => cfg });
  let sequence = 0;
  const enqueue = (text: string) => {
    sequence += 1;
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: `hot-debounce-${sequence}`,
        remoteJid: "999@s.whatsapp.net",
        text,
        timestamp: 1_700_000_000 + sequence,
      }),
    );
  };
  const publish = (debounceMs: number) => {
    cfg = { ...cfg, messages: { inbound: { byChannel: { whatsapp: debounceMs } } } };
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  try {
    enqueue("immediate");
    await waitForMessageCalls(onMessage, 1);
    publish(60_000);
    enqueue("first");
    await settleInboundWork();
    expect(onMessage).toHaveBeenCalledTimes(1);
    publish(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitForMessageCalls(onMessage, 2);
    enqueue("after disable");
    await waitForMessageCalls(onMessage, 3);
    expect(onMessage.mock.calls.map(([message]) => message.payload.body)).toEqual([
      "immediate",
      "first",
      "after disable",
    ]);
    publish(60_000);
    enqueue("pending at close");
    await settleInboundWork();
    expect(onMessage).toHaveBeenCalledTimes(3);
  } finally {
    await listener.close();
    vi.useRealTimers();
  }
  expect(onMessage).toHaveBeenCalledTimes(4);
  expect(onMessage.mock.calls.at(-1)?.[0].payload.body).toBe("pending at close");
  expect(sock.end).toHaveBeenCalledTimes(1);
});
