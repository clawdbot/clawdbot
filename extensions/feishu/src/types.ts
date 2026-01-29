export type FeishuConfig = {
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
};

export type FeishuAccount = {
  accountId: string;
  name?: string;
  enabled?: boolean;
  config: FeishuConfig;
};

export interface FeishuMessageEvent {
  message: {
    chat_id: string;
    message_id: string;
    chat_type: string;
    message_type: string; // SDK types say message_type, raw might be msg_type
    content: string; // JSON string
    create_time: string;
  };
  sender: {
    sender_id: {
      user_id?: string;
      open_id?: string;
      union_id?: string;
    };
    sender_type: string;
  };
}
