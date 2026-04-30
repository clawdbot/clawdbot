import { resolveDirectStatusReplyForSession } from "openclaw/plugin-sdk/command-status-runtime";
import * as pluginRuntime from "openclaw/plugin-sdk/plugin-runtime";
import { dispatchReplyWithDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";

export const nativeCommandRuntime = {
  matchPluginCommand: pluginRuntime.matchPluginCommand,
  executePluginCommand: pluginRuntime.executePluginCommand,
  dispatchReplyWithDispatcher,
  resolveDirectStatusReplyForSession,
  resolveDiscordNativeInteractionRouteState,
};

export const __testing = {
  setMatchPluginCommand(
    next: typeof pluginRuntime.matchPluginCommand,
  ): typeof pluginRuntime.matchPluginCommand {
    const previous = nativeCommandRuntime.matchPluginCommand;
    nativeCommandRuntime.matchPluginCommand = next;
    return previous;
  },
  setExecutePluginCommand(
    next: typeof pluginRuntime.executePluginCommand,
  ): typeof pluginRuntime.executePluginCommand {
    const previous = nativeCommandRuntime.executePluginCommand;
    nativeCommandRuntime.executePluginCommand = next;
    return previous;
  },
  setDispatchReplyWithDispatcher(
    next: typeof dispatchReplyWithDispatcher,
  ): typeof dispatchReplyWithDispatcher {
    const previous = nativeCommandRuntime.dispatchReplyWithDispatcher;
    nativeCommandRuntime.dispatchReplyWithDispatcher = next;
    return previous;
  },
  setResolveDirectStatusReplyForSession(
    next: typeof resolveDirectStatusReplyForSession,
  ): typeof resolveDirectStatusReplyForSession {
    const previous = nativeCommandRuntime.resolveDirectStatusReplyForSession;
    nativeCommandRuntime.resolveDirectStatusReplyForSession = next;
    return previous;
  },
  setResolveDiscordNativeInteractionRouteState(
    next: typeof resolveDiscordNativeInteractionRouteState,
  ): typeof resolveDiscordNativeInteractionRouteState {
    const previous = nativeCommandRuntime.resolveDiscordNativeInteractionRouteState;
    nativeCommandRuntime.resolveDiscordNativeInteractionRouteState = next;
    return previous;
  },
};
