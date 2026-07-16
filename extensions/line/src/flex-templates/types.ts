import type { messagingApi } from "@line/bot-sdk";

export type FlexContainer = messagingApi.FlexContainer;
export type FlexBubble = messagingApi.FlexBubble;
export type FlexCarousel = messagingApi.FlexCarousel;
export type FlexBox = messagingApi.FlexBox;
export type FlexText = messagingApi.FlexText;
export type FlexImage = messagingApi.FlexImage;
export type FlexButton = messagingApi.FlexButton;
export type FlexComponent = messagingApi.FlexComponent;
export type Action = messagingApi.Action;

export interface ListItem {
  title: string;
  subtitle?: string;
  action?: Action;
}

export interface CardAction {
  label: string;
  action: Action;
}
