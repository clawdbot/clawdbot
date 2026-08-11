import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import type { CloudSessionRecovery } from "../../lib/sessions/cloud-recovery.ts";
import type { NewSessionRouteData } from "./location.ts";
import "./new-session-page.ts";

type TestNewSessionPage = {
  data: NewSessionRouteData | undefined;
  folder: string;
  message: string;
  openedFor: string | null;
  visibility: "normal" | "draft" | "incognito";
  worktree: boolean;
  agentId: string;
  cloudProfileId: string;
  context: ApplicationContext;
  error: string | null;
  submitting: boolean;
  gatewayClient: ApplicationContext["gateway"]["snapshot"]["client"];
  gatewayConnected: boolean;
  gatewayRecoveryScope: string;
  gatewayUrl: string;
  pendingCloud: { capture(): CloudSessionRecovery | null };
  attachmentDraft: {
    attachments: ChatAttachment[];
    replace(attachments: ChatAttachment[]): void;
  };
  canSubmit(): boolean;
  submissionAccess(): { allowed: true };
  submit(): Promise<void>;
  setMessageFromUser(message: string): void;
  updated(): void;
};

function routeData(agentId: string, catalogId = ""): NewSessionRouteData {
  return {
    agentId,
    requestedAgentId: agentId,
    catalogId,
    model: "",
    catalogLabel: "",
    startTerminal: false,
  };
}

afterEach(() => {
  document.querySelectorAll("openclaw-new-session-page").forEach((element) => element.remove());
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("new session draft route ownership", () => {
  it("clears all source draft state when destination data is still pending", () => {
    const page = document.createElement(
      "openclaw-new-session-page",
    ) as unknown as TestNewSessionPage;
    page.data = routeData("research");
    page.updated();
    window.history.replaceState({}, "", "/new?agent=research");
    page.setMessageFromUser("source draft");
    page.folder = "/workspace/source";
    page.visibility = "incognito";
    page.worktree = true;

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    page.updated();

    expect(page.message).toBe("");
    expect(page.folder).toBe("");
    expect(page.visibility).toBe("normal");
    expect(page.worktree).toBe(false);
    expect(page.openedFor).toBe(JSON.stringify(["research", "claude"]));
  });

  it("keeps destination input through pending data, settlement, and agent resolution", () => {
    const page = document.createElement(
      "openclaw-new-session-page",
    ) as unknown as TestNewSessionPage;
    page.data = routeData("research");
    page.updated();

    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.data = undefined;
    page.updated();
    page.setMessageFromUser("keep this fast draft");

    page.data = {
      ...routeData("", "claude"),
      requestedAgentId: "research",
    };
    page.updated();
    expect(page.message).toBe("keep this fast draft");

    page.data = routeData("research", "claude");
    page.updated();

    expect(page.message).toBe("keep this fast draft");
  });

  it("clears a draft when a different route settles without destination-owned input", () => {
    const page = document.createElement(
      "openclaw-new-session-page",
    ) as unknown as TestNewSessionPage;
    page.data = routeData("research", "claude");
    page.updated();
    window.history.replaceState({}, "", "/new?agent=research&catalog=claude");
    page.setMessageFromUser("route-owned draft");

    window.history.replaceState({}, "", "/new?agent=main&catalog=codex");
    page.data = undefined;
    page.updated();

    expect(page.message).toBe("");
  });

  it("hands cloud startup to the application owner and navigates immediately", async () => {
    window.history.replaceState({}, "", "/new");
    const page = document.createElement(
      "openclaw-new-session-page",
    ) as unknown as TestNewSessionPage;
    Object.defineProperty(page, "isConnected", { configurable: true, value: true });
    const client = { recoveryScope: "principal-a", recoveryScopeReady: true };
    const createResult = vi.fn(async (params: Record<string, unknown>) => ({
      key: String(params.key),
      initialRun: { status: "idle" as const },
    }));
    const start = vi.fn(
      (_input: Parameters<ApplicationContext["cloudStartup"]["start"]>[0]) =>
        new Promise<void>(() => {
          // The application owner keeps loading after this route commits.
        }),
    );
    const navigate = vi.fn();
    const setSessionKey = vi.fn();
    const selectAgent = vi.fn();
    page.context = {
      basePath: "",
      gateway: {
        connection: { gatewayUrl: "ws://gateway.example" },
        snapshot: {
          phase: "connected",
          client,
          hello: { auth: { role: "operator", scopes: ["operator.admin"] } },
        },
        setSessionKey,
      },
      agents: { state: { agentsList: null } },
      agentSelection: { state: { selectedId: "cloud" }, set: selectAgent },
      sessions: { state: { result: null }, createResult },
      cloudStartup: { start },
      navigate,
    } as unknown as ApplicationContext;
    page.agentId = "cloud";
    page.cloudProfileId = "aws";
    page.message = "keep this cloud task";
    page.visibility = "normal";
    page.worktree = true;
    page.gatewayClient = client as ApplicationContext["gateway"]["snapshot"]["client"];
    page.gatewayConnected = true;
    page.gatewayRecoveryScope = client.recoveryScope;
    page.gatewayUrl = "ws://gateway.example";
    page.canSubmit = () => true;
    page.submissionAccess = () => ({ allowed: true });
    page.attachmentDraft.replace([
      {
        id: "attachment-1",
        dataUrl: "data:text/plain;base64,SGk=",
        mimeType: "text/plain",
        fileName: "note.txt",
      },
    ]);

    await page.submit();
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]?.[0].recovery).toMatchObject({
      message: "keep this cloud task",
      attachments: [{ fileName: "note.txt", content: "SGk=" }],
      phase: "dispatching",
    });
    expect(page.pendingCloud.capture()).toBeNull();
    expect(page.attachmentDraft.attachments).toHaveLength(0);
    expect(page.submitting).toBe(false);
    expect(createResult).toHaveBeenCalledOnce();
    expect(setSessionKey).toHaveBeenCalledWith(start.mock.calls[0]?.[0].recovery.sessionKey);
    expect(selectAgent).toHaveBeenCalledWith("cloud");
    expect(navigate).toHaveBeenCalledOnce();
  });
});
