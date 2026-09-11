/**
 * @lobstack/gateway — a typed client for the Lobstack Gateway, and the
 * published contract it speaks.
 *
 * The spec lives beside this code: `spec/openapi.yaml` describes the endpoints
 * and `spec/x_lobstack.schema.json` describes the receipt. This SDK is one
 * implementation of that contract, not the definition of it.
 *
 * Four things here are not conveniences:
 *
 *   • The base URL is `https://www.lobstack.ai/api/gateway/v1` — www, never the
 *     apex — and a cross-host redirect is refused rather than followed.
 *   • `costUsd` is `number | null`. Null means UNPRICED, not free.
 *   • `baselineReason` distinguishes a like-for-like saving from a comparison
 *     against a model the caller never asked for, and `describeSavings` will
 *     not label the two the same way.
 *   • The streamed receipt arrives AFTER `finish_reason`.
 */

export { LobstackGateway } from "./client.js";
export type {
  ChatResult,
  FetchLike,
  LobstackGatewayOptions,
  RequestOptions,
  StreamOptions,
  StreamResult,
  UsageQuery,
  Warning,
} from "./client.js";

export {
  API_KEY_PATTERN,
  DEFAULT_BASE_URL,
  DEFAULT_CLIENT_ID,
  DEFAULT_PLATFORM_BASE_URL,
  SDK_VERSION,
  apiKeyPrefix,
  isApiKeyShape,
} from "./constants.js";

export { isCrossOrigin, joinUrl, normalizeBaseUrl, platformBaseUrlFrom } from "./base-url.js";
export type { NormalizedBaseUrl } from "./base-url.js";

export {
  CrossHostRedirectError,
  LobstackConfigError,
  LobstackError,
  QuotaExhaustedError,
  StreamError,
  isLobstackError,
} from "./errors.js";
export type { GatewayErrorClass, LobstackErrorInit } from "./errors.js";

export {
  isPriced,
  mergeStreamReceipt,
  numericHeader,
  parseQuota,
  parseReceiptFrame,
  receiptFromHeaders,
  requirePriced,
} from "./receipt.js";
export type {
  BaselineReason,
  CountedQuota,
  HeaderBag,
  Mode,
  ModelTier,
  Principal,
  PricedFrom,
  QuotaSnapshot,
  Receipt,
  SpendQuota,
  UnknownQuota,
  XLobstack,
} from "./receipt.js";

export { collectStream, sseFrames, streamEvents } from "./stream.js";
export type { CollectHandlers } from "./stream.js";

export { describeSavings, formatCostUsd, formatQuota, formatReceipt } from "./format.js";
export type { SavingsClaim } from "./format.js";

export type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatRequest,
  Choice,
  ChunkChoice,
  ContentPart,
  GatewayErrorBody,
  GatewayModel,
  Message,
  ModelList,
  Role,
  RoutePreview,
  RoutePreviewRequest,
  StreamCollected,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  Usage,
  UsageDisabled,
  UsageEnabled,
  UsageGroup,
  UsageGroupBy,
  UsageRange,
  UsageReport,
  UsageSummary,
} from "./types.js";
