/**
 * Browser CLI observation commands for console, PDF, and response bodies.
 */
import type { Command } from "commander";
import type { JsonSchemaObject } from "openclaw/plugin-sdk/json-schema-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  completeBrowserExtract,
  resolveBrowserExtractTimeoutMs,
  validateBrowserExtractSchema,
} from "../browser-extract.js";
import { runCommandWithRuntime } from "../core-api.js";
import {
  completeWithPreparedSimpleCompletionModel,
  extractAssistantText,
  htmlToMarkdown,
  normalizeWhitespace,
  prepareSimpleCompletionModelForAgent,
  sanitizeHtml,
  validateJsonSchemaValue,
} from "../sdk-setup-tools.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  callBrowserRequest,
  parseBrowserPositiveIntegerOption,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";
import { danger, defaultRuntime, getRuntimeConfig, shortenHomePath } from "./core-api.js";

const browserCliExtractDeps = {
  completeWithPreparedSimpleCompletionModel,
  extractAssistantText,
  getRuntimeConfig,
  htmlToMarkdown,
  normalizeWhitespace,
  prepareSimpleCompletionModelForAgent,
  sanitizeHtml,
  validateJsonSchemaValue,
};

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseSchemaOption(value: string | undefined): JsonSchemaObject | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--schema must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--schema must be a JSON Schema object.");
  }
  return parsed as JsonSchemaObject;
}

function runBrowserObserve(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

/** Registers Browser commands that observe current page state without direct input. */
export function registerBrowserActionObserveCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("extract")
    .description("Answer a question from the current page")
    .argument("<question>", "Question to answer from page content")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option("--selector <css>", "Extract only matching page content")
    .option("--ignore-selector <css>", "CSS selector to omit (repeatable)", collectOption, [])
    .option("--schema <json>", "JSON Schema for structured output")
    .option("--timeout-ms <ms>", "Overall timeout (default: 60000)", (v: string) =>
      parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .action(async (question: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserObserve(async () => {
        const query = question.trim();
        if (!query) {
          throw new Error("question must not be empty");
        }
        const timeoutMs = resolveBrowserExtractTimeoutMs({ timeoutMs: opts.timeoutMs });
        const deadlineAt = Date.now() + timeoutMs;
        const selector = normalizeOptionalString(opts.selector);
        const ignoreSelectors = (opts.ignoreSelector as string[])
          .map((value) => normalizeOptionalString(value))
          .filter((value): value is string => Boolean(value));
        const schema = parseSchemaOption(normalizeOptionalString(opts.schema));
        if (schema) {
          const schemaError = validateBrowserExtractSchema(schema, browserCliExtractDeps);
          if (schemaError) {
            throw new Error(`Invalid extract schema: ${schemaError}`);
          }
        }
        const captured = await callBrowserRequest<{
          ok: boolean;
          targetId: string;
          url: string;
          html?: string;
          message?: string;
        }>(
          parent,
          {
            method: "POST",
            path: "/extract",
            query: profile ? { profile } : undefined,
            body: {
              targetId: normalizeOptionalString(opts.targetId),
              timeoutMs,
              ...(selector ? { selector } : {}),
              ...(ignoreSelectors.length > 0 ? { ignoreSelectors } : {}),
            },
          },
          { timeoutMs },
        );
        if (!captured.ok || typeof captured.html !== "string") {
          throw new Error(captured.message || "Browser extract page capture failed");
        }
        const result = await completeBrowserExtract({
          html: captured.html,
          url: captured.url,
          query,
          schema,
          schemaPrevalidated: Boolean(schema),
          agentId: "main",
          deadlineAt,
          deps: browserCliExtractDeps,
        });
        if ((result.details as { ok?: unknown } | undefined)?.ok === false) {
          const text = result.content.find((block) => block.type === "text")?.text;
          throw new Error(text || "Browser extract failed");
        }
        if (parent?.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        const text = result.content.find((block) => block.type === "text")?.text;
        if (text) {
          defaultRuntime.log(text);
        }
      });
    });

  browser
    .command("console")
    .description("Get recent console messages")
    .option("--level <level>", "Filter by level (error, warn, info)")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserObserve(async () => {
        const result = await callBrowserRequest<{ messages: unknown[] }>(
          parent,
          {
            method: "GET",
            path: "/console",
            query: {
              level: normalizeOptionalString(opts.level),
              targetId: normalizeOptionalString(opts.targetId),
              profile,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.writeJson(result.messages);
      });
    });

  browser
    .command("pdf")
    .description("Save page as PDF")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserObserve(async () => {
        const result = await callBrowserRequest<{ path: string }>(
          parent,
          {
            method: "POST",
            path: "/pdf",
            query: profile ? { profile } : undefined,
            body: { targetId: normalizeOptionalString(opts.targetId) },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.log(`PDF: ${shortenHomePath(result.path)}`);
      });
    });

  browser
    .command("responsebody")
    .description("Wait for a network response and return its body")
    .argument("<url>", "URL (exact, substring, or glob like **/api)")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the response (default: 20000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .option("--max-chars <n>", "Max body chars to return (default: 200000)", (v: string) =>
      parseBrowserPositiveIntegerOption(v, "--max-chars"),
    )
    .action(async (url: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserObserve(async () => {
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined;
        const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : undefined;
        const result = await callBrowserRequest<{ response: { body: string } }>(
          parent,
          {
            method: "POST",
            path: "/response/body",
            query: profile ? { profile } : undefined,
            body: {
              url,
              targetId: normalizeOptionalString(opts.targetId),
              timeoutMs,
              maxChars,
            },
          },
          { timeoutMs: timeoutMs ?? 20000 },
        );
        if (parent?.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.log(result.response.body);
      });
    });
}
