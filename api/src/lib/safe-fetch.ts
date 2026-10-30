import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";

const blockedAddresses = new BlockList();
// The same ranges, kept apart by family for isPrivateAddress. Node's BlockList
// checks an IPv4 address against IPv6 rules as ::ffff:<address>, so the
// ::ffff:0:0/96 rule above matches every IPv4 address, public ones included.
const privateV4 = new BlockList();
const privateV6 = new BlockList();
// IPv6 prefixes that carry an IPv4 address in their last 32 bits.
const embedsV4 = new BlockList();
embedsV4.addSubnet("::ffff:0:0", 96, "ipv6");
embedsV4.addSubnet("64:ff9b::", 96, "ipv6");

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
  privateV4.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
  if (network !== "::ffff:0:0") privateV6.addSubnet(network, prefix, "ipv6");
}

export interface PinnedRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type ResolvedAddress = { address: string; family: number };

export interface SafeFetchResult {
  response: Response;
  finalUrl: URL;
}

/**
 * Parse an agent-supplied URL and reject syntax that can target a local
 * service. DNS/IP checks happen separately immediately before the request.
 */
export function parsePublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("unsafe_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsafe_url");
  if (url.username || url.password) throw new Error("unsafe_url");
  if ((url.protocol === "http:" && url.port && url.port !== "80") ||
      (url.protocol === "https:" && url.port && url.port !== "443")) {
    throw new Error("unsafe_url");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname ||
      hostname === "localhost" ||
      !hostname.includes(".") ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".home.arpa")) {
    throw new Error("unsafe_url");
  }
  if (isIP(hostname) && isBlockedAddress(hostname)) throw new Error("unsafe_url");
  return url;
}

/**
 * Fetch an untrusted URL without exposing private networks. Every redirect is
 * revalidated and the request is pinned to the vetted DNS result, preventing
 * DNS rebinding between validation and connection.
 */
export async function safePublicFetch(
  rawUrl: string,
  options: { signal?: AbortSignal; maxRedirects?: number } = {},
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 3;
  let url = parsePublicHttpUrl(rawUrl);

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await requestPinned(url, { signal: options.signal }, await vettedAddresses(url.hostname, defaultResolve, isBlockedAddress));
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: url };
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirect === maxRedirects) throw new Error("unsafe_redirect");
    url = parsePublicHttpUrl(new URL(location, url).toString());
  }
  throw new Error("unsafe_redirect");
}

/**
 * The addresses <hostname> resolves to, when every one is public. Throws
 * unsafe_url when any is private, local or link-local, or when none resolve.
 */
export async function publicAddresses(
  hostname: string,
  resolve: (hostname: string) => Promise<ResolvedAddress[]> = defaultResolve,
): Promise<ResolvedAddress[]> {
  return vettedAddresses(hostname, resolve, isPrivateAddress);
}

const defaultResolve = (name: string): Promise<ResolvedAddress[]> => lookup(name, { all: true, verbatim: true });

async function vettedAddresses(
  hostname: string,
  resolve: (hostname: string) => Promise<ResolvedAddress[]>,
  blocked: (address: string) => boolean,
): Promise<ResolvedAddress[]> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const answers = isIP(bare) ? [{ address: bare, family: isIP(bare) }] : await resolve(bare);
  if (!answers.length || answers.some((answer) => blocked(answer.address))) {
    throw new Error("unsafe_url");
  }
  return answers;
}

/**
 * One request to <url>, connected to the first vetted address so DNS cannot
 * change between the check and the connection. Redirects are not followed.
 */
export async function requestPinned(url: URL, init: PinnedRequest, answers: ResolvedAddress[]): Promise<Response> {
  const pinned = answers[0];
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      signal: init.signal,
      // Node asks with { all: true } on its connect path and expects a list.
      lookup: ((_host: string, options: { all?: boolean }, callback: (error: Error | null, address: string | ResolvedAddress[], family?: number) => void) => {
        if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      }) as never,
    }, (res) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const status = res.statusCode ?? 502;
      const body = status === 204 || status === 304
        ? undefined
        : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, headers }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) return blockedAddresses.check(address, "ipv6");
  return true;
}

/**
 * True for a private, local, link-local, reserved or multicast address, and
 * for anything that is not an IP address. An IPv6 address that carries an IPv4
 * address (::ffff:a.b.c.d, 64:ff9b::a.b.c.d) is judged by that IPv4 address.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateV4.check(address, "ipv4");
  if (family !== 6) return true;
  if (embedsV4.check(address, "ipv6")) {
    const v4 = embeddedV4(address);
    return v4 === null || privateV4.check(v4, "ipv4");
  }
  return privateV6.check(address, "ipv6");
}

function embeddedV4(address: string): string | null {
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (dotted) return isIP(dotted[1]) === 4 ? dotted[1] : null;
  const groups = /:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!groups) return null;
  const [high, low] = [parseInt(groups[1], 16), parseInt(groups[2], 16)];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
