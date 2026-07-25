// Logbook plugin entrypoint: automatic work journal built from screen snapshots.
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveLogbookConfig } from "./src/config.js";
import { LogbookService } from "./src/service.js";
import { dayKeyFor } from "./src/store.js";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const logbookConfigSchema = {
  parse(value: unknown) {
    return resolveLogbookConfig(value);
  },
};

function readDayParam(params: unknown): string {
  const day = (params as { day?: unknown } | undefined)?.day;
  if (day === undefined) {
    return dayKeyFor(Date.now());
  }
  if (typeof day !== "string" || !DAY_PATTERN.test(day)) {
    throw new Error("day must be YYYY-MM-DD");
  }
  return day;
}

function readNumberParam(params: unknown, key: string): number {
  const value = (params as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
}

const logbookNodeHostCommands: OpenClawPluginNodeHostCommand[] = [
  {
    command: "logbook.snapshot",
    cap: "screen",
    dangerous: false,
    handle: async (paramsJSON) => {
      const { handleLogbookSnapshot } = await import("./src/node-host.js");
      let params: unknown;
      try {
        params = paramsJSON ? JSON.parse(paramsJSON) : undefined;
      } catch {
        params = undefined;
      }
      return JSON.stringify(await handleLogbookSnapshot(params));
    },
  },
];

export default definePluginEntry({
  id: "logbook",
  name: "Logbook",
  description: "Automatic work journal built from periodic screen snapshots",
  configSchema: logbookConfigSchema,
  nodeHostCommands: logbookNodeHostCommands,
  register(api: OpenClawPluginApi) {
    const config = logbookConfigSchema.parse(api.pluginConfig);
    let service: LogbookService | null = null;

    const requireService = () => {
      if (!service) {
        throw new Error("Logbook service is not running");
      }
      return service;
    };

    const sendError = (respond: GatewayRequestHandlerOptions["respond"], err: unknown) => {
      const message = formatErrorMessage(err);
      respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
    };

    const handle =
      (run: (params: unknown) => unknown) =>
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          respond(true, await run(params));
        } catch (err) {
          sendError(respond, err);
        }
      };

    // Declares the dashboard tab; the Control UI renders it only while this
    // plugin is active, so no core code references the plugin id.
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "logbook",
      label: "Logbook",
      description: "Your day as a timeline, built from screen snapshots.",
      icon: "sun",
      group: "control",
      requiredScopes: ["operator.write"],
    });

    // Adds logbook.snapshot to the default macOS node allowlist; without a
    // policy the gateway strips plugin commands from pairing surfaces.
    api.registerNodeInvokePolicy({
      commands: ["logbook.snapshot"],
      defaultPlatforms: ["macos"],
      handle: async (ctx) => {
        // Honor the operator's screen-capture kill switch: a screen.snapshot
        // deny must block this capture command too, not just the app node's.
        const denied = ctx.config.gateway?.nodes?.denyCommands ?? [];
        if (denied.includes("screen.snapshot")) {
          return {
            ok: false,
            code: "SCREEN_CAPTURE_DENIED",
            message:
              "screen capture is denied by gateway.nodes.denyCommands (screen.snapshot); Logbook capture stays blocked until it is removed",
          };
        }
        return await ctx.invokeNode();
      },
    });

    api.registerService({
      id: "logbook",
      start: (ctx) => {
        service = new LogbookService(config, {
          runtime: api.runtime,
          fullConfig: ctx.config,
          logger: ctx.logger,
          dataDir: path.join(ctx.stateDir, "logbook"),
        });
        service.start();
      },
      stop: () => {
        service?.stop();
        service = null;
      },
    });

    // Unscoped plugin methods are authorized as operator.admin; explicit
    // scopes keep the tab usable for read/write-scoped Control UI sessions.
    const registerRead = (method: string, run: (params: unknown) => unknown) =>
      api.registerGatewayMethod(method, handle(run), { scope: "operator.read" });
    const registerWrite = (method: string, run: (params: unknown) => unknown) =>
      api.registerGatewayMethod(method, handle(run), { scope: "operator.write" });

    // Raw frame bytes are the most sensitive payload (full screen contents),
    // so they require write scope while derived text stays readable.
    registerRead("logbook.status", () => requireService().status());

    registerRead("logbook.days", () => ({ days: requireService().listDays() }));

    registerRead("logbook.timeline", (params) => {
      const day = readDayParam(params);
      const svc = requireService();
      return { day, cards: svc.cardsForDay(day), stats: svc.dayStats(day) };
    });

    registerWrite("logbook.frames", (params) => {
      const startMs = readNumberParam(params, "startMs");
      const endMs = readNumberParam(params, "endMs");
      const frames = requireService()
        .framesInRange(startMs, endMs)
        .map((frame) => ({ id: frame.id, capturedAtMs: frame.capturedAtMs, idle: frame.idle }));
      return { frames };
    });

    registerWrite("logbook.frame", (params) => {
      const frameId = readNumberParam(params, "frameId");
      const frame = requireService().frameById(frameId);
      if (!frame) {
        throw new Error(`frame ${frameId} not found`);
      }
      return {
        frameId: frame.id,
        capturedAtMs: frame.capturedAtMs,
        width: frame.width,
        height: frame.height,
        format: "jpeg",
        base64: readFileSync(frame.path).toString("base64"),
      };
    });

    // Standup and ask spend model tokens; capture/analyze mutate runtime state.
    registerWrite("logbook.standup", (params) => {
      const refresh = (params as { refresh?: unknown } | undefined)?.refresh === true;
      return requireService().standup(readDayParam(params), refresh);
    });

    registerWrite("logbook.ask", async (params) => {
      const question = (params as { question?: unknown } | undefined)?.question;
      if (typeof question !== "string" || question.trim().length === 0) {
        throw new Error("question is required");
      }
      const answer = await requireService().ask(readDayParam(params), question.trim());
      return { answer };
    });

    registerWrite("logbook.capture.set", (params) => {
      const paused = (params as { paused?: unknown } | undefined)?.paused === true;
      const svc = requireService();
      svc.setCapturePaused(paused);
      return svc.status();
    });

    registerWrite("logbook.analyze.now", () => requireService().analyzeNow());
  },
});
