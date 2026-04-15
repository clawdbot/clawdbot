import { vi } from "vitest";

const sendMocks = vi.hoisted(() => ({
  sendMessageZalouserMock: vi.fn(async () => {}),
  sendTypingZalouserMock: vi.fn(async () => {}),
  sendDeliveredZalouserMock: vi.fn(async () => {}),
  sendSeenZalouserMock: vi.fn(async () => {}),
}));

export const sendMessageZalouserMock = sendMocks.sendMessageZalouserMock;
export const sendTypingZalouserMock = sendMocks.sendTypingZalouserMock;
export const sendDeliveredZalouserMock = sendMocks.sendDeliveredZalouserMock;
export const sendSeenZalouserMock = sendMocks.sendSeenZalouserMock;

vi.mock("./send.js", () => ({
  sendMessageZalouser: sendMessageZalouserMock,
  sendTypingZalouser: sendTypingZalouserMock,
  sendDeliveredZalouser: sendDeliveredZalouserMock,
  sendSeenZalouser: sendSeenZalouserMock,
}));
