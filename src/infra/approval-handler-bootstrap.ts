import { resolveChannelApprovalCapability } from "../channels/plugins/approvals.js";
import type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  createChannelApprovalHandlerFromCapability,
  type ChannelApprovalHandler,
} from "./approval-handler-runtime.js";
import {
  getChannelRuntimeContext,
  watchChannelRuntimeContexts,
} from "./channel-runtime-context.js";
import { isExecApprovalChannelRuntimeTerminalStartError } from "./exec-approval-channel-runtime.js";

type ApprovalBootstrapHandler = ChannelApprovalHandler;
const APPROVAL_HANDLER_BOOTSTRAP_RETRY_MS = 1_000;

export async function startChannelApprovalHandlerBootstrap(params: {
  plugin: Pick<ChannelPlugin, "id" | "meta" | "approvalCapability">;
  cfg: OpenClawConfig;
  accountId: string;
  channelRuntime?: ChannelRuntimeSurface;
  logger?: ReturnType<typeof createSubsystemLogger>;
}): Promise<() => Promise<void>> {
  const capability = resolveChannelApprovalCapability(params.plugin);
  if (!capability?.nativeRuntime || !params.channelRuntime) {
    return async () => {};
  }

  const channelLabel = params.plugin.meta.label || params.plugin.id;
  const logger = params.logger ?? createSubsystemLogger(`${params.plugin.id}/approval-bootstrap`);
  let activeGeneration = 0;
  let activeHandler: ApprovalBootstrapHandler | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  const invalidateActiveHandler = () => {
    activeGeneration += 1;
  };
  const clearRetryTimer = () => {
    if (!retryTimer) {
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const stopHandler = async () => {
    const handler = activeHandler;
    activeHandler = null;
    if (!handler) {
      return;
    }
    await handler.stop();
  };

  const startHandlerForContext = async (context: unknown, generation: number) => {
    if (generation !== activeGeneration) {
      return;
    }
    await stopHandler();
    if (generation !== activeGeneration) {
      return;
    }
    const handler = await createChannelApprovalHandlerFromCapability({
      capability,
      label: `${params.plugin.id}/native-approvals`,
      clientDisplayName: `${channelLabel} Native Approvals (${params.accountId})`,
      channel: params.plugin.id,
      channelLabel,
      cfg: params.cfg,
      accountId: params.accountId,
      context,
    });
    if (!handler) {
      return;
    }
    if (generation !== activeGeneration) {
      await handler.stop().catch(() => {});
      return;
    }
    activeHandler = handler as ApprovalBootstrapHandler;
    try {
      await handler.start();
    } catch (error) {
      if (activeHandler === handler) {
        activeHandler = null;
      }
      await handler.stop().catch(() => {});
      throw error;
    }
  };

  const spawn = (label: string, promise: Promise<void>) => {
    void promise.catch((error) => {
      logger.error(`${label}: ${String(error)}`);
    });
  };
  const scheduleRetryForContext = (context: unknown, generation: number) => {
    if (generation !== activeGeneration) {
      return;
    }
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (generation !== activeGeneration) {
        return;
      }
      spawn(
        "failed to retry native approval handler",
        startHandlerForRegisteredContext(context, generation),
      );
    }, APPROVAL_HANDLER_BOOTSTRAP_RETRY_MS);
    retryTimer.unref?.();
  };
  const startHandlerForRegisteredContext = async (context: unknown, generation: number) => {
    try {
      await startHandlerForContext(context, generation);
    } catch (error) {
      if (generation === activeGeneration) {
        if (isExecApprovalChannelRuntimeTerminalStartError(error)) {
          logger.error(`native approval handler disabled: ${String(error)}`);
          return;
        }
        logger.error(`failed to start native approval handler: ${String(error)}`);
        scheduleRetryForContext(context, generation);
      }
    }
  };

  const unsubscribe =
    watchChannelRuntimeContexts({
      channelRuntime: params.channelRuntime,
      channelId: params.plugin.id,
      accountId: params.accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      onEvent: (event) => {
        if (event.type === "registered") {
          clearRetryTimer();
          invalidateActiveHandler();
          const generation = activeGeneration;
          spawn(
            "failed to start native approval handler",
            startHandlerForRegisteredContext(event.context, generation),
          );
          return;
        }
        clearRetryTimer();
        invalidateActiveHandler();
        spawn("failed to stop native approval handler", stopHandler());
      },
    }) ?? (() => {});

  const existingContext = getChannelRuntimeContext({
    channelRuntime: params.channelRuntime,
    channelId: params.plugin.id,
    accountId: params.accountId,
    capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  });
  if (existingContext !== undefined) {
    clearRetryTimer();
    invalidateActiveHandler();
    const generation = activeGeneration;
    spawn(
      "failed to start native approval handler",
      startHandlerForRegisteredContext(existingContext, generation),
    );
  }

  return async () => {
    unsubscribe();
    clearRetryTimer();
    invalidateActiveHandler();
    await stopHandler();
  };
}
