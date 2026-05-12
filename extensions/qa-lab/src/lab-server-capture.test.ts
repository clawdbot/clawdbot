import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { mapCaptureEventForQa, probeTcpReachability } from "./lab-server-capture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("qa-lab server capture helpers", () => {
  it("maps capture rows into QA-friendly fields", () => {
    const record = mapCaptureEventForQa({
      flowId: "flow-1",
      dataText: '{"hello":"world"}',
      metaJson: JSON.stringify({
        provider: "openai",
        api: "responses",
        model: "gpt-5.5",
        captureOrigin: "shared-fetch",
      }),
    }) as ReturnType<typeof mapCaptureEventForQa> & { flowId?: string };
    expect(record.flowId).toBe("flow-1");
    expect(record.payloadPreview).toBe('{"hello":"world"}');
    expect(record.provider).toBe("openai");
    expect(record.api).toBe("responses");
    expect(record.model).toBe("gpt-5.5");
    expect(record.captureOrigin).toBe("shared-fetch");
  });

  it("probes tcp reachability for reachable and unreachable targets", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    cleanups.push(
      async () =>
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected tcp probe address");
    }

    const reachable = await probeTcpReachability(`http://127.0.0.1:${address.port}`);
    expect(reachable.ok).toBe(true);
    const unreachable = await probeTcpReachability("http://127.0.0.1:9", 50);
    expect(unreachable.ok).toBe(false);
  });
});
