import {
  LoginQRCallbackEventType,
  Reactions,
  TextStyle,
  ThreadType,
  type Style,
} from "./zca-constants.js";

type ZcaJsRuntime = {
  Zalo: unknown;
};
let zcaJsRuntimePromise: Promise<ZcaJsRuntime> | null = null;

async function loadZcaJsRuntime(): Promise<ZcaJsRuntime> {
  // Keep zca-js behind a runtime boundary so bundled metadata/contracts can load
  // without resolving its optional WebSocket dependency tree.
  zcaJsRuntimePromise ??= import("zca-js").then((mod) => mod as unknown as ZcaJsRuntime);
  return await zcaJsRuntimePromise;
}

export { LoginQRCallbackEventType, Reactions, TextStyle, ThreadType };
export type { Style };

export type Credentials = {
  imei: string;
  cookie: unknown;
  userAgent: string;
  language?: string;
};

export type User = {
  userId: string;
  username: string;
  displayName: string;
  zaloName: string;
  avatar: string;
};

export type GroupInfo = {
  groupId: string;
  name: string;
  totalMember?: number;
  memberIds?: unknown[];
  currentMems?: Array<{
    id?: unknown;
    dName?: string;
    zaloName?: string;
    avatar?: string;
  }>;
};

export type Message = {
  type: number;
  threadId: string;
  isSelf: boolean;
  data: Record<string, unknown>;
};

export type LoginQRCallbackEvent =
  | {
      type: 0;
      data: {
        code: string;
        image: string;
      };
      actions: {
        saveToFile: (qrPath?: string) => Promise<unknown>;
        retry: () => unknown;
        abort: () => unknown;
      };
    }
  | {
      type: 1;
      data: null;
      actions: {
        retry: () => unknown;
        abort: () => unknown;
      };
    }
  | {
      type: 2;
      data: {
        avatar: string;
        display_name: string;
      };
      actions: {
        retry: () => unknown;
        abort: () => unknown;
      };
    }
  | {
      type: 3;
      data: {
        code: string;
      };
      actions: {
        retry: () => unknown;
        abort: () => unknown;
      };
    }
  | {
      type: 4;
      data: {
        cookie: unknown;
        imei: string;
        userAgent: string;
      };
      actions: null;
    };

export type Listener = {
  on(event: "message", callback: (message: Message) => void): void;
  on(event: "error", callback: (error: unknown) => void): void;
  on(event: "closed", callback: (code: number, reason: string) => void): void;
  off(event: "message", callback: (message: Message) => void): void;
  off(event: "error", callback: (error: unknown) => void): void;
  off(event: "closed", callback: (code: number, reason: string) => void): void;
  start(opts?: { retryOnClose?: boolean }): void;
  stop(): void;
};

type DeliveryEventMessage = {
  msgId: string;
  cliMsgId: string;
  uidFrom: string;
  idTo: string;
  msgType: string;
  st: number;
  at: number;
  cmd: number;
  ts: string | number;
};

type DeliveryEventMessages = DeliveryEventMessage | DeliveryEventMessage[];

export type API = {
  listener: Listener;
  getContext(): {
    imei: string;
    userAgent: string;
    language?: string;
  };
  getCookie(): {
    toJSON(): {
      cookies: unknown[];
    };
  };
  fetchAccountInfo(): Promise<User | { profile: User }>;
  getAllFriends(): Promise<User[]>;
  getOwnId(): string;
  getAllGroups(): Promise<{
    gridVerMap: Record<string, string>;
  }>;
  getGroupInfo(groupId: string | string[]): Promise<{
    gridInfoMap: Record<string, GroupInfo & { memVerList?: unknown }>;
  }>;
  getGroupMembersInfo(memberId: string | string[]): Promise<{
    profiles: Record<
      string,
      {
        id?: string;
        displayName?: string;
        zaloName?: string;
        avatar?: string;
      }
    >;
  }>;
  sendMessage(
    message: string | Record<string, unknown>,
    threadId: string,
    type?: number,
  ): Promise<{
    msgId?: string | number;
    message?: { msgId?: string | number } | null;
    attachment?: Array<{ msgId?: string | number }>;
  }>;
  uploadAttachment(
    sources:
      | string
      | {
          data: Buffer;
          filename: `${string}.${string}`;
          metadata: {
            totalSize: number;
            width?: number;
            height?: number;
          };
        }
      | Array<
          | string
          | {
              data: Buffer;
              filename: `${string}.${string}`;
              metadata: {
                totalSize: number;
                width?: number;
                height?: number;
              };
            }
        >,
    threadId: string,
    type?: number,
  ): Promise<
    Array<{
      fileType: "image" | "video" | "others";
      fileUrl?: string;
      msgId?: string | number;
      fileId?: string;
      fileName?: string;
    }>
  >;
  sendVoice(
    options: {
      voiceUrl: string;
      ttl?: number;
    },
    threadId: string,
    type?: number,
  ): Promise<{ msgId?: string | number }>;
  sendLink(
    payload: { link: string; msg?: string },
    threadId: string,
    type?: number,
  ): Promise<{ msgId?: string | number }>;
  sendTypingEvent(threadId: string, type?: number, destType?: number): Promise<{ status: number }>;
  addReaction(
    icon: string | { rType: number; source: number; icon: string },
    dest: {
      data: {
        msgId: string;
        cliMsgId: string;
      };
      threadId: string;
      type: number;
    },
  ): Promise<unknown>;
  sendDeliveredEvent(
    isSeen: boolean,
    messages: DeliveryEventMessages,
    type?: number,
  ): Promise<unknown>;
  sendSeenEvent(messages: DeliveryEventMessages, type?: number): Promise<unknown>;
};

type ZaloCtor = new (options?: { logging?: boolean; selfListen?: boolean }) => {
  login(credentials: Credentials): Promise<API>;
  loginQR(
    options?: { userAgent?: string; language?: string; qrPath?: string },
    callback?: (event: LoginQRCallbackEvent) => unknown,
  ): Promise<API>;
};

export async function createZalo(
  options?: ConstructorParameters<ZaloCtor>[0],
): Promise<InstanceType<ZaloCtor>> {
  const zcaJs = await loadZcaJsRuntime();
  const Zalo = zcaJs.Zalo as ZaloCtor;
  return new Zalo(options);
}
