import process from "node:process";

process.on("SIGTERM", () => {
  // Force the parent test through its SIGKILL path.
});

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.once("end", () => {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (input.databasePath === "fixture:malformed") {
    process.stdout.write("not-json");
    return;
  }
  if (input.databasePath === "fixture:oversized") {
    process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1024, 120));
    return;
  }
  if (input.databasePath === "fixture:early-exit") {
    process.exit(7);
  }
  process.stderr.write("ready\n");
  const deadline = performance.now() + Math.max(0, Number(input.request?.limit ?? 0));
  while (performance.now() < deadline) {
    // Model a synchronous native SQLite call that cannot service messages.
  }
  process.stdout.write(
    JSON.stringify({ status: "ok", value: { rows: [], fallbackScanRequired: false } }),
  );
});
process.stdin.resume();
