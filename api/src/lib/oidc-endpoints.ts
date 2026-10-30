import { isIP } from "node:net";
import { parsePublicHttpUrl, publicAddresses, requestPinned, type PinnedRequest, type ResolvedAddress } from "./safe-fetch.js";

// Hosts an issuer may put its endpoints on besides its own origin. The api
// fetches the token and userinfo endpoints that an issuer's discovery document
// names, so an endpoint on another origin is accepted only on a host listed
// here for that issuer, over https, and only while every address it resolves
// to is public.
export const OIDC_ENDPOINT_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "https://accounts.google.com": ["oauth2.googleapis.com", "openidconnect.googleapis.com"],
};

export type OidcProvider = "google" | "oidc";

type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;

function issuerKey(issuer: string): string {
  return issuer.replace(/\/+$/, "").toLowerCase();
}

export function oidcProvider(issuer: string): OidcProvider {
  return issuerKey(issuer) === "https://accounts.google.com" ? "google" : "oidc";
}

export interface CheckedEndpoint {
  url: URL;
  // The vetted addresses for a cross-origin endpoint; null on the issuer's own origin.
  addresses: ResolvedAddress[] | null;
}

/**
 * Checks one endpoint from <issuer>'s discovery document. An endpoint on the
 * issuer's own origin passes, as before. Any other endpoint must be https on
 * the default port, on a host named for the issuer in OIDC_ENDPOINT_HOSTS, and
 * resolve only to public addresses.
 */
export async function checkOidcEndpoint(issuer: string, endpoint: string, resolve?: Resolve): Promise<CheckedEndpoint> {
  const from = new URL(issuer);
  const url = new URL(endpoint);
  if (url.origin === from.origin) return { url, addresses: null };
  const allowed = OIDC_ENDPOINT_HOSTS[issuerKey(issuer)] ?? [];
  const host = url.hostname.toLowerCase();
  if (from.protocol !== "https:" || url.protocol !== "https:" || isIP(host.replace(/^\[|\]$/g, "")) || !allowed.includes(host)) {
    throw new Error("oidc_cross_origin_endpoint");
  }
  try {
    parsePublicHttpUrl(endpoint);
  } catch {
    throw new Error("oidc_cross_origin_endpoint");
  }
  try {
    return { url, addresses: await publicAddresses(host, resolve) };
  } catch (e) {
    if ((e as Error).message === "unsafe_url") throw new Error("oidc_endpoint_not_public");
    throw e;
  }
}

/**
 * Sends one request to an endpoint from <issuer>'s discovery document. A
 * cross-origin endpoint is checked again and connected to its vetted address,
 * so a DNS change between the check and the request cannot reach a private one.
 */
export async function oidcFetch(issuer: string, endpoint: string, init: PinnedRequest, resolve?: Resolve): Promise<Response> {
  const checked = await checkOidcEndpoint(issuer, endpoint, resolve);
  if (!checked.addresses) return fetch(checked.url, init);
  return requestPinned(checked.url, init, checked.addresses);
}
