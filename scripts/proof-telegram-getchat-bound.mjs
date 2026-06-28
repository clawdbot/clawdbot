import { once } from "node:events";
// Loopback proof: fetchTelegramChatId (getChat) through the production Bot API read path.
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TELEGRAM_BOT_API_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const { fetchTelegramChatId } = await import(`${pkgRoot}/extensions/telegram/src/api-fetch.ts`);

const CAP = TELEGRAM_BOT_API_MAX_RESPONSE_BYTES;
const STREAM_SIZE = 24 * 1024 * 1024;

let allPassed = true;
function check(label, val) {
  console.log(`  ${val ? "ok" : "FAIL"}: ${label}`);
  if (!val) {
    allPassed = false;
  }
}

let serverBytesWritten = 0;

function createStreamingServer() {
  return createServer((req, res) => {
    if (req.url === "/huge") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const chunk = Buffer.alloc(65536, 120);
      const header = Buffer.from('{"ok":true,"result":{"id":1');
      res.write(header);
      serverBytesWritten += header.length;
      let sent = header.length;
      const writeNext = () => {
        if (sent >= STREAM_SIZE) {
          const tail = Buffer.from("}}");
          res.write(tail);
          serverBytesWritten += tail.length;
          res.end();
          return;
        }
        const ok = res.write(chunk);
        serverBytesWritten += chunk.length;
        sent += chunk.length;
        if (ok) {
          setImmediate(writeNext);
        } else {
          res.once("drain", writeNext);
        }
      };
      writeNext();
      return;
    }
    if (req.url?.includes("/getChat")) {
      const chatId = new URL(req.url, "http://127.0.0.1").searchParams.get("chat_id");
      if (chatId === "OVERSIZED") {
        res.writeHead(200, { "Content-Type": "application/json" });
        const chunk = Buffer.alloc(65536, 120);
        const header = Buffer.from('{"ok":true,"result":{"id":1');
        res.write(header);
        serverBytesWritten += header.length;
        let sent = header.length;
        const writeNext = () => {
          if (sent >= STREAM_SIZE) {
            const tail = Buffer.from("}}");
            res.write(tail);
            serverBytesWritten += tail.length;
            res.end();
            return;
          }
          const ok = res.write(chunk);
          serverBytesWritten += chunk.length;
          sent += chunk.length;
          if (ok) {
            setImmediate(writeNext);
          } else {
            res.once("drain", writeNext);
          }
        };
        writeNext();
        return;
      }
      const body = JSON.stringify({ ok: true, result: { id: 123456789 } });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      res.end(body);
      serverBytesWritten += Buffer.byteLength(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

async function withServer(fn) {
  serverBytesWritten = 0;
  const server = createStreamingServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    await new Promise((resolveDone) => {
      server.close(resolveDone);
    });
  }
}

console.log(`\n[proof] fetchTelegramChatId (getChat) production path`);
console.log(`  cap=${CAP} bytes (4 MiB), would-stream≈${STREAM_SIZE} bytes (24 MiB)\n`);

await withServer(async (port) => {
  serverBytesWritten = 0;
  const chatId = await fetchTelegramChatId({
    token: "proof-token",
    chatId: "OVERSIZED",
    apiRoot: `http://127.0.0.1:${port}`,
  });
  await new Promise((r) => {
    setTimeout(r, 50);
  });
  check(
    "oversized getChat fails closed with null (production fetchTelegramChatId)",
    chatId === null,
  );
  check(
    `server wrote ${serverBytesWritten} bytes, stopped before full 24 MiB stream`,
    serverBytesWritten < STREAM_SIZE && serverBytesWritten > CAP,
  );
});

await withServer(async (port) => {
  serverBytesWritten = 0;
  const res = await fetch(`http://127.0.0.1:${port}/huge`);
  await res.json().catch(() => undefined);
  await new Promise((r) => {
    setTimeout(r, 50);
  });
  check(
    `negative control: unbounded .json() wrote ${serverBytesWritten} bytes (>> ${CAP})`,
    serverBytesWritten > CAP,
  );
});

await withServer(async (port) => {
  serverBytesWritten = 0;
  const chatId = await fetchTelegramChatId({
    token: "proof-token",
    chatId: "-100123",
    apiRoot: `http://127.0.0.1:${port}`,
  });
  check(`small getChat parsed through production path (id=${chatId})`, chatId === "123456789");
});

console.log(allPassed ? "\nALL PROOF ASSERTIONS PASSED" : "\nSOME ASSERTIONS FAILED");
process.exit(allPassed ? 0 : 1);
