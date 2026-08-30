// Private, test-only Matrix/core ownership fixtures. Keeping this outside the
// common test-fixtures barrel prevents host-runtime imports from perturbing
// unrelated unit-test mock initialization.
export { createChannelOwnerProofFixture } from "./test-helpers/channel-owner-proof-fixture.js";
export { readSourceFinalizationPrivateOptions as readSourceFinalizationPrivateOptionsForTest } from "../auto-reply/reply/source-finalization-private.js";
