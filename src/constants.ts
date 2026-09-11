/**
 * Constants that are part of the contract rather than a convenience.
 */

/**
 * The Gateway's base URL. `www`, never the apex.
 *
 * `https://lobstack.ai` answers with a 307 to `https://www.lobstack.ai`, and
 * RFC 9110 §15.4 requires a client to drop `Authorization` when a redirect
 * changes the host. The Gateway then sees a request with no credential at all
 * and answers a perfectly good key with "missing credentials" — the single most
 * expensive gotcha this API has, because the error names the wrong thing and
 * sends you looking at your key.
 *
 * This SDK defaults here, refuses to follow a cross-host redirect, and corrects
 * the apex out loud if you configure it. See `normalizeBaseUrl`.
 */
export const DEFAULT_BASE_URL = "https://www.lobstack.ai/api/gateway/v1";

/** The platform (non-Gateway) API root, where the usage endpoint lives. */
export const DEFAULT_PLATFORM_BASE_URL = "https://www.lobstack.ai/api/v1";

/** Kept in step with package.json by hand; it is only ever sent as a label. */
export const SDK_VERSION = "0.1.0";

/** Sent as `x-lobstack-client`, which the Gateway records on the trace row. */
export const DEFAULT_CLIENT_ID = `lobstack-gateway-sdk/${SDK_VERSION}`;

/**
 * The shape of an API key: `lsk_live_` or `lsk_test_`, an 8-hex selector, then
 * a 48-hex secret. The selector is not secret and is safe to log; the rest is.
 */
export const API_KEY_PATTERN = /^lsk_(?:live|test)_[0-9a-f]{8}[0-9a-f]{48}$/;

/** True when a credential is shaped like a Lobstack API key. */
export function isApiKeyShape(token: string | null | undefined): boolean {
  return typeof token === "string" && API_KEY_PATTERN.test(token.trim());
}

/** The non-secret lookup handle of a key, for logs and UI. Null if not a key. */
export function apiKeyPrefix(token: string | null | undefined): string | null {
  if (!isApiKeyShape(token)) return null;
  return (token as string).trim().slice(0, 17);
}
