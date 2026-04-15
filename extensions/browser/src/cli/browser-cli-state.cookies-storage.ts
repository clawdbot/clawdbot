import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { callBrowserRequest, type BrowserParentOpts } from "./browser-cli-shared.js";
import { danger, defaultRuntime, inheritOptionFromParent } from "./core-api.js";

function resolveUrl(opts: { url?: string }, command: Command): string | undefined {
  return (
    normalizeOptionalString(opts.url) ??
    normalizeOptionalString(inheritOptionFromParent<string>(command, "url"))
  );
}

function resolveTargetId(rawTargetId: unknown, command: Command): string | undefined {
  return (
    normalizeOptionalString(rawTargetId) ??
    normalizeOptionalString(inheritOptionFromParent<string>(command, "targetId"))
  );
}

async function runMutationRequest(params: {
  parent: BrowserParentOpts;
  request: Parameters<typeof callBrowserRequest>[1];
  successMessage: string;
}) {
  try {
    const result = await callBrowserRequest(params.parent, params.request, { timeoutMs: 20000 });
    if (params.parent?.json) {
      defaultRuntime.writeJson(result);
      return;
    }
    defaultRuntime.log(params.successMessage);
  } catch (err) {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  }
}

export function registerBrowserCookiesAndStorageCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const cookies = browser.command("cookies").description("Read/write cookies");

  cookies
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      const targetId = resolveTargetId(opts.targetId, cmd);
      try {
        const result = await callBrowserRequest<{ cookies?: unknown[] }>(
          parent,
          {
            method: "GET",
            path: "/cookies",
            query: {
              targetId,
              profile,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.writeJson(result.cookies ?? []);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  cookies
    .command("set")
    .description("Set a cookie (requires --url or domain+path)")
    .argument("<name>", "Cookie name")
    .argument("<value>", "Cookie value")
    .option("--url <url>", "Cookie URL scope (recommended)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (name: string, value: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      const targetId = resolveTargetId(opts.targetId, cmd);
      const url = resolveUrl(opts, cmd);
      if (!url) {
        defaultRuntime.error(danger("Missing required --url option for cookies set"));
        defaultRuntime.exit(1);
        return;
      }
      await runMutationRequest({
        parent,
        request: {
          method: "POST",
          path: "/cookies/set",
          query: profile ? { profile } : undefined,
          body: {
            targetId,
            cookie: { name, value, url },
          },
        },
        successMessage: `cookie set: ${name}`,
      });
    });

  cookies
    .command("clear")
    .description("Clear all cookies")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      const targetId = resolveTargetId(opts.targetId, cmd);
      await runMutationRequest({
        parent,
        request: {
          method: "POST",
          path: "/cookies/clear",
          query: profile ? { profile } : undefined,
          body: {
            targetId,
          },
        },
        successMessage: "cookies cleared",
      });
    });

  const storage = browser.command("storage").description("Read/write localStorage/sessionStorage");

  function registerStorageKind(kind: "local" | "session") {
    const cmd = storage.command(kind).description(`${kind}Storage commands`);

    cmd
      .command("get")
      .description(`Get ${kind}Storage (all keys or one key)`)
      .argument("[key]", "Key (optional)")
      .option("--target-id <id>", "CDP target id (or unique prefix)")
      .action(async (key: string | undefined, opts, cmd2) => {
        const parent = parentOpts(cmd2);
        const profile = parent?.browserProfile;
        const targetId = resolveTargetId(opts.targetId, cmd2);
        try {
          const result = await callBrowserRequest<{ values?: Record<string, string> }>(
            parent,
            {
              method: "GET",
              path: `/storage/${kind}`,
              query: {
                key: normalizeOptionalString(key),
                targetId,
                profile,
              },
            },
            { timeoutMs: 20000 },
          );
          if (parent?.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          defaultRuntime.writeJson(result.values ?? {});
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      });

    cmd
      .command("set")
      .description(`Set a ${kind}Storage key`)
      .argument("<key>", "Key")
      .argument("<value>", "Value")
      .option("--target-id <id>", "CDP target id (or unique prefix)")
      .action(async (key: string, value: string, opts, cmd2) => {
        const parent = parentOpts(cmd2);
        const profile = parent?.browserProfile;
        const targetId = resolveTargetId(opts.targetId, cmd2);
        await runMutationRequest({
          parent,
          request: {
            method: "POST",
            path: `/storage/${kind}/set`,
            query: profile ? { profile } : undefined,
            body: {
              key,
              value,
              targetId,
            },
          },
          successMessage: `${kind}Storage set: ${key}`,
        });
      });

    cmd
      .command("clear")
      .description(`Clear all ${kind}Storage keys`)
      .option("--target-id <id>", "CDP target id (or unique prefix)")
      .action(async (opts, cmd2) => {
        const parent = parentOpts(cmd2);
        const profile = parent?.browserProfile;
        const targetId = resolveTargetId(opts.targetId, cmd2);
        await runMutationRequest({
          parent,
          request: {
            method: "POST",
            path: `/storage/${kind}/clear`,
            query: profile ? { profile } : undefined,
            body: {
              targetId,
            },
          },
          successMessage: `${kind}Storage cleared`,
        });
      });
  }

  registerStorageKind("local");
  registerStorageKind("session");
}
