// Readability Basic Compare script supports OpenClaw repository automation.
import { createWebFetchTool } from "../src/agents/tools/web-tools.js";

const DEFAULT_URLS = [
  "https://example.com/",
  "https://news.ycombinator.com/",
  "https://www.reddit.com/r/javascript/",
  "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/User-Agent",
  "https://httpbin.org/html",
];

const urls = process.argv.slice(2);
const targets = urls.length > 0 ? urls : DEFAULT_URLS;

async function runFetch(url: string, readability: boolean) {
  if (!readability) {
    throw new Error("Basic extraction removed. Set readability=true or enable Firecrawl.");
  }
  const tool = createWebFetchTool({
    config: {
      tools: {
        web: { fetch: { readability, cacheTtlMinutes: 0, firecrawl: { enabled: false } } },
      },
    },
    sandboxed: false,
  });
  if (!tool) {
    throw new Error("web_fetch tool is disabled");
  }
  const result = await tool.execute("test", { url, extractMode: "markdown" });
  return result.details as {
    text?: string;
    title?: string;
    extractor?: string;
    length?: number;
    truncated?: boolean;
  };
}

function truncate(value: string, max = 160): string {
  if (!value) {
    return "";
  }
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

async function run() {
  for (const url of targets) {
    console.log(`\n=== ${url}`);
    const readable = await runFetch(url, true);

    console.log(
      `readability: ${readable.extractor ?? "unknown"} len=${readable.length ?? 0} title=${truncate(
        readable.title ?? "",
        80,
      )}`,
    );
    if (readable.text) {
      console.log(`readability sample: ${truncate(readable.text)}`);
    }
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
