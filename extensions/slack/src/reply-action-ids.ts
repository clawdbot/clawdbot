// Slack plugin module implements reply action ids behavior.
export const SLACK_REPLY_BUTTON_ACTION_ID = "openclaw:reply_button";
export const SLACK_REPLY_LINK_ACTION_ID = "openclaw:reply_link";
export const SLACK_REPLY_SELECT_ACTION_ID = "openclaw:reply_select";
export const SLACK_CALLBACK_BUTTON_ACTION_ID = "openclaw:callback_button";
export const SLACK_CALLBACK_SELECT_ACTION_ID = "openclaw:callback_select";
export const SLACK_APPROVAL_BUTTON_ACTION_ID = "openclaw:approval_button";
export const SLACK_APPROVAL_SELECT_ACTION_ID = "openclaw:approval_select";
export const SLACK_QUESTION_BUTTON_ACTION_ID = "openclaw:question_button";

export function isSlackQuestionActionId(actionId: string): boolean {
  return (
    actionId === SLACK_QUESTION_BUTTON_ACTION_ID ||
    actionId.startsWith(`${SLACK_QUESTION_BUTTON_ACTION_ID}:`)
  );
}

export function isSlackApprovalActionId(actionId: string): boolean {
  return (
    actionId === SLACK_APPROVAL_BUTTON_ACTION_ID ||
    actionId === SLACK_APPROVAL_SELECT_ACTION_ID ||
    actionId.startsWith(`${SLACK_APPROVAL_BUTTON_ACTION_ID}:`) ||
    actionId.startsWith(`${SLACK_APPROVAL_SELECT_ACTION_ID}:`)
  );
}

export function isSlackCallbackActionId(actionId: string): boolean {
  return (
    actionId === SLACK_CALLBACK_BUTTON_ACTION_ID ||
    actionId === SLACK_CALLBACK_SELECT_ACTION_ID ||
    actionId.startsWith(`${SLACK_CALLBACK_BUTTON_ACTION_ID}:`) ||
    actionId.startsWith(`${SLACK_CALLBACK_SELECT_ACTION_ID}:`)
  );
}
