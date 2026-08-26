import { authFormatCases } from "./failover-classification.auth-format.cases.js";
import { billingCases } from "./failover-classification.billing.cases.js";
import { legacyBillingACases } from "./failover-classification.legacy-billing-a.cases.js";
import { legacyBillingBCases } from "./failover-classification.legacy-billing-b.cases.js";
import { legacyProviderMatcherCases } from "./failover-classification.legacy-provider-matchers.cases.js";
import { overflowServerMiscCases } from "./failover-classification.overflow-server-misc.cases.js";
import { overflowCases } from "./failover-classification.overflow.cases.js";
import { rateLimitOverloadCases } from "./failover-classification.rate-limit-overload.cases.js";
import { structuredMiscCases } from "./failover-classification.structured-misc.cases.js";

export const failoverClassificationCorpus = [
  ...overflowCases,
  ...billingCases,
  ...rateLimitOverloadCases,
  ...overflowServerMiscCases,
  ...authFormatCases,
  ...structuredMiscCases,
  ...legacyBillingACases,
  ...legacyBillingBCases,
  ...legacyProviderMatcherCases,
];
