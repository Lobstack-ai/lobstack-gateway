import { DEFAULT_BASE_URL } from "./constants.js";
import { LobstackConfigError } from "./errors.js";

export interface NormalizedBaseUrl {
  /** The base URL to call, with any trailing slash removed. */
  baseUrl: string;
  /** True when the input was rewritten rather than used as given. */
  corrected: boolean;
  /** Why it was rewritten. Null when nothing was. */
  note: string | null;
}

/**
 * Normalise a base URL, and correct the one host that silently breaks auth.
 *
 * `lobstack.ai` redirects to `www.lobstack.ai`, and every conforming HTTP
 * client drops `Authorization` across that host change (RFC 9110 §15.4). A
 * caller who passes the apex gets "missing credentials" while holding a valid
 * key. So the apex is rewritten — and the rewrite is announced through
 * `corrected`, because a silent fix teaches you nothing about why the same
 * mistake will break your own code tomorrow.
 *
 * Any other host is left exactly as given. This is a correction for one known
 * redirect, not a policy about other people's domains.
 */
export function normalizeBaseUrl(input?: string | null): NormalizedBaseUrl {
  const raw = (input ?? "").trim() || DEFAULT_BASE_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LobstackConfigError(
      `baseUrl is not a URL: ${JSON.stringify(raw)}`,
      `Pass an absolute URL, e.g. ${DEFAULT_BASE_URL}`,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LobstackConfigError(
      `baseUrl must be http or https, got ${url.protocol}`,
      `Pass an absolute URL, e.g. ${DEFAULT_BASE_URL}`,
    );
  }

  if (url.hostname === "lobstack.ai") {
    url.hostname = "www.lobstack.ai";
    return {
      baseUrl: stripTrailingSlash(url.toString()),
      corrected: true,
      note:
        "lobstack.ai redirects to www.lobstack.ai, and a client must drop Authorization " +
        "across a host change (RFC 9110). Using www.lobstack.ai directly; point your " +
        "configuration at www so your other clients do not fail the same way.",
    };
  }

  return { baseUrl: stripTrailingSlash(url.toString()), corrected: false, note: null };
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** Join a base URL and a path without producing a double slash. */
export function joinUrl(base: string, path: string): string {
  return `${stripTrailingSlash(base)}/${path.replace(/^\/+/, "")}`;
}

/**
 * Where the usage API lives, derived from the Gateway base URL.
 *
 * `GET /api/v1/usage` is NOT under the Gateway base: the Gateway serves
 * `/api/gateway/v1/**` and usage is a platform endpoint one level up. Deriving
 * it rather than hard-coding it keeps a self-hosted or staging base working.
 */
export function platformBaseUrlFrom(baseUrl: string): string {
  const url = new URL(baseUrl);
  const trimmed = stripTrailingSlash(url.pathname);
  url.pathname = trimmed.endsWith("/api/gateway/v1")
    ? `${trimmed.slice(0, -"/api/gateway/v1".length)}/api/v1`
    : "/api/v1";
  return stripTrailingSlash(url.toString());
}

/** True when two URLs differ in scheme, host or port — where credentials are dropped. */
export function isCrossOrigin(from: string, to: string): boolean {
  try {
    return new URL(from).origin !== new URL(to, from).origin;
  } catch {
    // An unparseable Location is not something to follow either.
    return true;
  }
}
