/**
 * Model metadata re-exported from @contextio/core.
 *
 * Context-lens inherits pricing, context limits, and cost estimation
 * from the shared contextio package. This file is the single import
 * point so the rest of the codebase doesn't import from @contextio/core
 * directly.
 */

export {
  CONTEXT_LIMITS,
  estimateCost,
  getContextLimit,
  getKnownModels,
  MODEL_PRICING,
} from "@contextio/core";
