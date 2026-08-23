type LiveScenarioReplyMessage = {
  messageId: string | number;
  text: string;
  [key: string]: unknown;
};

export function assertLiveScenarioReply(params: {
  expectedTextIncludes?: string[];
  message: LiveScenarioReplyMessage;
}) {
  if (!params.message.text.trim()) {
    throw new Error(`reply message ${params.message.messageId} was empty`);
  }
  for (const expected of params.expectedTextIncludes ?? []) {
    if (!params.message.text.includes(expected)) {
      throw new Error(
        `reply message ${params.message.messageId} missing expected text: ${expected}`,
      );
    }
  }
}
