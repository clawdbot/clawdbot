import { BUZZ_PROFILE_QUERY_CHUNK_SIZE } from "./directory-state.js";

const BUZZ_RELAY_MAX_SUBSCRIPTIONS = 1_024;
const BUZZ_RELAY_MEMBERSHIP_NOTIFICATION_SUBSCRIPTIONS = 1;
const BUZZ_RELAY_MAX_CONCURRENT_QUERY_SUBSCRIPTIONS = 3;
const BUZZ_RELAY_NON_ROOM_PROFILE_SUBSCRIPTION_RESERVE =
  BUZZ_RELAY_MEMBERSHIP_NOTIFICATION_SUBSCRIPTIONS + BUZZ_RELAY_MAX_CONCURRENT_QUERY_SUBSCRIPTIONS;
const BUZZ_DIRECTORY_MAX_PROFILE_SUBSCRIPTIONS = 10;

export const BUZZ_MAX_CONFIGURED_ROOMS =
  BUZZ_RELAY_MAX_SUBSCRIPTIONS - BUZZ_RELAY_NON_ROOM_PROFILE_SUBSCRIPTION_RESERVE;

export function resolveBuzzSubscriptionBudget(roomCount: number): {
  profileLimit: number;
} {
  if (!Number.isSafeInteger(roomCount) || roomCount < 0) {
    throw new Error("Buzz configured room count must be a non-negative integer");
  }
  const availableProfileSubscriptions =
    BUZZ_RELAY_MAX_SUBSCRIPTIONS - BUZZ_RELAY_NON_ROOM_PROFILE_SUBSCRIPTION_RESERVE - roomCount;
  if (availableProfileSubscriptions < 0) {
    throw new Error(
      `Buzz supports at most ${BUZZ_MAX_CONFIGURED_ROOMS} configured rooms per account`,
    );
  }
  return {
    profileLimit:
      Math.min(BUZZ_DIRECTORY_MAX_PROFILE_SUBSCRIPTIONS, availableProfileSubscriptions) *
      BUZZ_PROFILE_QUERY_CHUNK_SIZE,
  };
}
