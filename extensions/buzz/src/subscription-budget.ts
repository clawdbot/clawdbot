import { BUZZ_PROFILE_QUERY_CHUNK_SIZE } from "./directory-state.js";

const BUZZ_RELAY_MAX_SUBSCRIPTIONS = 1_024;
const BUZZ_RELAY_MEMBERSHIP_NOTIFICATION_SUBSCRIPTIONS = 1;
const BUZZ_RELAY_MAX_CONCURRENT_QUERY_SUBSCRIPTIONS = 3;

/**
 * Reply-target lookups share the query reserve above rather than growing it, so
 * the configured-room cap stays where it is. Inbound replay dispatches up to
 * eight messages at once; without this ceiling their REQs could push past the
 * relay's subscription cap on a room set near the maximum, where the excess is
 * refused and quotes vanish intermittently.
 */
export const BUZZ_MAX_CONCURRENT_REPLY_TARGET_LOOKUPS =
  BUZZ_RELAY_MAX_CONCURRENT_QUERY_SUBSCRIPTIONS;
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
