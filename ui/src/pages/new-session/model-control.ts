import type { ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { renderChatModelControls } from "../chat/components/chat-model-controls.ts";

export class NewSessionModelControl {
  private requestToken = 0;
  private catalog: ModelCatalogEntry[] = [];
  private loading = false;
  selected = "";

  constructor(private readonly notify: () => void) {}

  invalidate(resetSelection = false) {
    this.requestToken += 1;
    this.loading = false;
    this.catalog = [];
    if (resetSelection) {
      this.selected = "";
    }
  }

  reset() {
    this.invalidate(true);
    this.notify();
  }

  load(context: ApplicationContext | undefined, agentId: string, enabled: boolean) {
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const normalizedAgentId = normalizeAgentId(agentId);
    const requestId = ++this.requestToken;
    this.catalog = [];
    if (!snapshot?.connected || !client || !normalizedAgentId || !enabled) {
      this.loading = false;
      this.notify();
      return;
    }
    this.loading = true;
    this.notify();
    void client
      .request<{ models?: ModelCatalogEntry[] }>("chat.metadata", {
        agentId: normalizedAgentId,
      })
      .then((result) => {
        if (requestId === this.requestToken) {
          this.catalog = Array.isArray(result.models) ? result.models : [];
        }
      })
      .catch(() => {
        if (requestId === this.requestToken) {
          this.catalog = [];
        }
      })
      .finally(() => {
        if (requestId === this.requestToken) {
          this.loading = false;
          this.notify();
        }
      });
  }

  render(options: {
    agentDefaultModel?: string;
    agentId: string;
    context: ApplicationContext | undefined;
    sending: boolean;
  }) {
    const snapshot = options.context?.gateway.snapshot;
    const sessionKey = `new-session:${normalizeAgentId(options.agentId)}`;
    return renderChatModelControls({
      activeRunId: null,
      agentDefaultModel: options.agentDefaultModel,
      connected: snapshot?.connected === true,
      gatewayAvailable: Boolean(snapshot?.client),
      loading: false,
      modelCatalog: this.catalog,
      modelOverrides: { [sessionKey]: this.selected },
      modelSwitching: false,
      modelsLoading: this.loading,
      mode: "model",
      sending: options.sending,
      sessionKey,
      sessionsResult: options.context?.sessions.state.result ?? null,
      stream: null,
      onModelSelect: (value) => {
        this.selected = value;
      },
      onRequestUpdate: this.notify,
    });
  }
}
