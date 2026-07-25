import { createLazyImportLoader } from "../../shared/lazy-promise.js";

const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));
const getReplyFromConfigRuntimeLoader = createLazyImportLoader(
  () => import("./get-reply-from-config.runtime.js"),
);
const abortRuntimeLoader = createLazyImportLoader(() => import("./abort.runtime.js"));
const runtimePluginsLoader = createLazyImportLoader(
  () => import("../../plugins/runtime-plugins.runtime.js"),
);
const replyMediaPathsRuntimeLoader = createLazyImportLoader(
  () => import("./reply-media-paths.runtime.js"),
);

export function loadRouteReplyRuntime() {
  return routeReplyRuntimeLoader.load();
}

export function loadGetReplyFromConfigRuntime() {
  return getReplyFromConfigRuntimeLoader.load();
}

export function loadAbortRuntime() {
  return abortRuntimeLoader.load();
}

export function loadRuntimePlugins() {
  return runtimePluginsLoader.load();
}

export function loadReplyMediaPathsRuntime() {
  return replyMediaPathsRuntimeLoader.load();
}
