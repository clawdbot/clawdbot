import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { t } from "../../i18n/index.ts";
import { generateUUID } from "../../lib/uuid.ts";
import pluginUiBridgeChildUrl from "./plugin-ui-bridge-child.js?url&no-inline";
import { PluginUiBridgeController } from "./plugin-ui-bridge.ts";
import { pluginTabKey } from "./route.ts";

function policyDirectives(policy: string): Array<{ name: string; value: string }> {
  return policy
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name = "", ...values] = directive.split(/\s+/u);
      return { name: name.toLowerCase(), value: values.join(" ") };
    });
}

function validateBridgeScriptPolicy(policy: string, sourceOrigin: string, bridgeUrl: string): void {
  const directives = policyDirectives(policy);
  const scriptPolicy =
    directives.find((directive) => directive.name === "script-src-elem") ??
    directives.find((directive) => directive.name === "script-src") ??
    directives.find((directive) => directive.name === "default-src");
  if (!scriptPolicy) {
    return;
  }
  const sources = scriptPolicy.value.split(/\s+/u);
  if (sources.includes("'strict-dynamic'")) {
    throw new Error("Plugin UI CSP cannot authorize the core bridge script safely");
  }
  const bridge = new URL(bridgeUrl);
  const allowed = sources.some((source) => {
    if (source === "*" || source === "'self'" || source === sourceOrigin) {
      return true;
    }
    if (/^[a-z][a-z0-9+.-]*:$/iu.test(source)) {
      return source.toLowerCase() === bridge.protocol;
    }
    try {
      const allowedUrl = new URL(source);
      if (allowedUrl.origin !== bridge.origin) {
        return false;
      }
      return allowedUrl.pathname.endsWith("/")
        ? bridge.pathname.startsWith(allowedUrl.pathname)
        : bridge.pathname === allowedUrl.pathname;
    } catch {
      return false;
    }
  });
  if (!allowed) {
    throw new Error("Plugin UI CSP blocks the core bridge script");
  }
}

function validateResponsePolicy(policy: string, sourceOrigin: string, bridgeUrl: string): void {
  // The Fetch Headers API comma-combines repeated CSP fields. Re-emitting that
  // value as one meta policy would weaken their intersection, so fail closed.
  if (policy.includes(",")) {
    throw new Error("Plugin UI returned multiple or ambiguous CSP policies");
  }
  validateBridgeScriptPolicy(policy, sourceOrigin, bridgeUrl);
  const frameAncestors = policyDirectives(policy).find(
    (directive) => directive.name === "frame-ancestors",
  );
  if (!frameAncestors) {
    validateBasePolicy(policy, sourceOrigin);
    return;
  }
  const sources = frameAncestors.value.split(/\s+/u);
  if (!sources.some((source) => source === "*" || source === "'self'" || source === sourceOrigin)) {
    throw new Error("Plugin UI CSP does not allow the Control UI to embed it");
  }
  validateBasePolicy(policy, sourceOrigin);
}

function validateBasePolicy(policy: string, sourceOrigin: string): void {
  const baseUri = policyDirectives(policy).find((directive) => directive.name === "base-uri");
  if (!baseUri) {
    return;
  }
  const sources = baseUri.value.split(/\s+/u);
  if (!sources.some((source) => source === "*" || source === "'self'" || source === sourceOrigin)) {
    throw new Error("Plugin UI CSP cannot preserve its route-relative base URL");
  }
}

function tightenIframeSandbox(sandbox: string, policy?: string): string {
  if (!policy) {
    return sandbox;
  }
  const policySandbox = policyDirectives(policy).find((directive) => directive.name === "sandbox");
  if (!policySandbox) {
    return sandbox;
  }
  const allowed = new Set(policySandbox.value.split(/\s+/u).filter(Boolean));
  const tightened = sandbox
    .split(/\s+/u)
    .filter((token) => token && allowed.has(token))
    .join(" ");
  if (!tightened.split(/\s+/u).includes("allow-scripts")) {
    throw new Error("Plugin UI CSP disables the action bridge script");
  }
  return tightened;
}

function adaptContentSecurityPolicy(policy: string, sourceOrigin: string): string {
  const unsupportedMetaDirectives = new Set(["frame-ancestors", "report-uri", "sandbox"]);
  return policy
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => {
      const name = directive.split(/\s+/u, 1)[0]?.toLowerCase();
      return name && !unsupportedMetaDirectives.has(name);
    })
    .map((directive) => directive.replaceAll("'self'", sourceOrigin))
    .join("; ");
}

function buildPluginUiBridgeDocument(params: {
  html: string;
  path: string;
  nonce: string;
  sandbox: string;
  contentSecurityPolicy?: string;
  referrerPolicy?: string;
}): { srcdoc: string; sandbox: string } {
  const routeUrl = new URL(params.path, window.location.href);
  const bridgeUrl = new URL(pluginUiBridgeChildUrl, window.location.href).href;
  if (params.contentSecurityPolicy) {
    validateResponsePolicy(params.contentSecurityPolicy, routeUrl.origin, bridgeUrl);
  }
  const sandbox = tightenIframeSandbox(params.sandbox, params.contentSecurityPolicy);
  const parsed = new DOMParser().parseFromString(params.html, "text/html");
  const existingBase = parsed.querySelector<HTMLBaseElement>("base[href]");
  const fallbackBase = existingBase ? null : parsed.createElement("base");
  if (existingBase) {
    existingBase.href = new URL(existingBase.getAttribute("href") ?? "", routeUrl).href;
  } else {
    fallbackBase!.href = routeUrl.href;
  }

  const documentPolicies = Array.from(
    parsed.querySelectorAll<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]'),
  );
  for (const meta of documentPolicies) {
    validateBridgeScriptPolicy(meta.content, routeUrl.origin, bridgeUrl);
    validateBasePolicy(meta.content, routeUrl.origin);
    meta.content = adaptContentSecurityPolicy(meta.content, routeUrl.origin);
  }
  const responseCsp = params.contentSecurityPolicy ? parsed.createElement("meta") : null;
  if (responseCsp) {
    responseCsp.httpEquiv = "Content-Security-Policy";
    responseCsp.content = adaptContentSecurityPolicy(
      params.contentSecurityPolicy!,
      routeUrl.origin,
    );
  }
  const referrer = params.referrerPolicy ? parsed.createElement("meta") : null;
  if (referrer) {
    referrer.name = "referrer";
    referrer.content = params.referrerPolicy!;
  }
  const bridge = parsed.createElement("script");
  bridge.src = bridgeUrl;
  bridge.dataset.openclawPluginUiNonce = params.nonce;
  parsed.head.prepend(
    ...[responseCsp].filter((node) => node !== null),
    ...documentPolicies,
    bridge,
    ...[referrer, fallbackBase].filter((node) => node !== null),
  );

  const doctype = params.html.match(/<!doctype[^>]*>/iu)?.[0] ?? "";
  return { srcdoc: `${doctype}${parsed.documentElement.outerHTML}`, sandbox };
}

class PluginUiDocumentController {
  current: { key: string; srcdoc: string; sandbox: string } | null = null;
  errorKey: string | null = null;
  private loadingKey = "";
  private abortController: AbortController | null = null;

  constructor(private readonly requestUpdate: () => void) {}

  clear() {
    this.abortController?.abort();
    this.abortController = null;
    this.loadingKey = "";
    this.current = null;
    this.errorKey = null;
  }

  ensure(key: string, path: string, nonce: string, sandbox: string) {
    if (this.current?.key === key || this.loadingKey === key || this.errorKey === key) {
      return;
    }
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.loadingKey = key;
    this.errorKey = null;
    void fetch(path, {
      credentials: "include",
      redirect: "error",
      signal: abortController.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Plugin UI request failed (${response.status})`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType && contentType.split(";", 1)[0]?.trim().toLowerCase() !== "text/html") {
          throw new Error("Plugin UI route did not return HTML");
        }
        const contentDisposition = response.headers.get("content-disposition")?.trim();
        if (contentDisposition && !/^inline(?:\s*;|$)/iu.test(contentDisposition)) {
          throw new Error("Plugin UI route did not return inline content");
        }
        const contentSecurityPolicy = response.headers.get("content-security-policy") ?? undefined;
        const xFrameOptions = response.headers.get("x-frame-options")?.trim().toLowerCase();
        if (xFrameOptions && xFrameOptions !== "sameorigin") {
          throw new Error("Plugin UI response does not allow the Control UI to embed it");
        }
        return buildPluginUiBridgeDocument({
          html: await response.text(),
          path,
          nonce,
          sandbox,
          contentSecurityPolicy,
          referrerPolicy: response.headers.get("referrer-policy") ?? undefined,
        });
      })
      .then((document) => this.finish(key, abortController, { key, ...document }))
      .catch(() => this.finish(key, abortController, null));
  }

  private finish(
    key: string,
    abortController: AbortController,
    document: { key: string; srcdoc: string; sandbox: string } | null,
  ) {
    if (this.loadingKey !== key || this.abortController !== abortController) {
      return;
    }
    this.loadingKey = "";
    this.abortController = null;
    this.current = document;
    this.errorKey = document ? null : key;
    this.requestUpdate();
  }
}

export class PluginUiFrameController {
  readonly bridge = new PluginUiBridgeController();
  private identity = "";
  private nonce = "";
  readonly document = new PluginUiDocumentController(() => this.requestUpdate());

  constructor(private readonly requestUpdate: () => void) {}

  detach(resetIdentity: boolean) {
    this.bridge.clear();
    if (resetIdentity) {
      this.identity = "";
      this.nonce = "";
      this.document.clear();
    }
  }

  clear() {
    this.detach(true);
  }

  resolve(params: {
    pluginId: string;
    tabId: string;
    path: string;
    label: string;
    sandbox: string;
    bridgeEnabled: boolean;
  }) {
    const identity = `${pluginTabKey({ pluginId: params.pluginId, id: params.tabId })}\0${params.path}\0${params.sandbox}\0${params.bridgeEnabled}`;
    if (this.identity !== identity) {
      this.identity = identity;
      this.nonce = params.bridgeEnabled ? generateUUID() : "";
    }
    if (!params.bridgeEnabled) {
      return html`<iframe
        class="plugin-tab-embed__frame"
        src=${params.path}
        title=${params.label}
        sandbox=${params.sandbox}
      ></iframe>`;
    }

    const documentKey = `${identity}\0${this.nonce}`;
    this.document.ensure(documentKey, params.path, this.nonce, params.sandbox);
    if (this.document.errorKey === documentKey) {
      return html`
        <section class="card lazy-view-state" role="status">
          <div class="card-title">${t("pluginTabs.unavailableTitle")}</div>
          <div class="card-sub">${t("pluginTabs.unavailableSubtitle")}</div>
        </section>
      `;
    }
    if (this.document.current?.key !== documentKey) {
      return nothing;
    }
    return keyed(
      identity,
      html`<iframe
        class="plugin-tab-embed__frame"
        srcdoc=${this.document.current.srcdoc}
        title=${params.label}
        sandbox=${this.document.current.sandbox}
      ></iframe>`,
    );
  }

  get bridgeNonce(): string {
    return this.nonce;
  }
}
