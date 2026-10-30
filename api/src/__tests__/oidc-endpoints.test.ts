import { afterEach, describe, expect, it, vi } from "vitest";
import { checkOidcEndpoint, oidcFetch, oidcProvider, OIDC_ENDPOINT_HOSTS } from "../lib/oidc-endpoints.js";
import { isPrivateAddress, publicAddresses } from "../lib/safe-fetch.js";

const GOOGLE = "https://accounts.google.com";
// The endpoints in Google's discovery document that the api reads.
const GOOGLE_ENDPOINTS = {
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
};

const resolvesTo = (...addresses: string[]) => vi.fn(async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
const publicDns = resolvesTo("142.250.80.10");

afterEach(() => vi.restoreAllMocks());

describe("OIDC endpoints on another origin", () => {
  it("accepts every endpoint in Google's discovery document", async () => {
    for (const endpoint of Object.values(GOOGLE_ENDPOINTS)) {
      await expect(checkOidcEndpoint(GOOGLE, endpoint, publicDns)).resolves.toMatchObject({ url: new URL(endpoint) });
    }
    await expect(checkOidcEndpoint(`${GOOGLE}/`, GOOGLE_ENDPOINTS.token_endpoint, publicDns)).resolves.toBeTruthy();
  });

  it("keeps an endpoint on the issuer's own origin as before, with no DNS check", async () => {
    const resolve = resolvesTo("10.0.0.1");
    await expect(checkOidcEndpoint("https://idp.example.com", "https://idp.example.com/token", resolve)).resolves.toEqual({ url: new URL("https://idp.example.com/token"), addresses: null });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["a host not on Google's list", GOOGLE, "https://evil.example.com/token"],
    ["a look-alike Google host", GOOGLE, "https://oauth2.googleapis.com.evil.example/token"],
    ["Google's host over http", GOOGLE, "http://oauth2.googleapis.com/token"],
    ["Google's host on another port", GOOGLE, "https://oauth2.googleapis.com:8443/token"],
    ["credentials in the URL", GOOGLE, "https://user:pass@oauth2.googleapis.com/token"],
    ["a literal IP address", GOOGLE, "https://169.254.169.254/latest/meta-data/"],
    ["Google's host for an issuer without that host", "https://idp.example.com", "https://oauth2.googleapis.com/token"],
    ["an http issuer", "http://accounts.google.com", "https://oauth2.googleapis.com/token"],
  ])("refuses %s", async (_name, issuer, endpoint) => {
    const resolve = resolvesTo("142.250.80.10");
    await expect(checkOidcEndpoint(issuer, endpoint, resolve)).rejects.toThrow("oidc_cross_origin_endpoint");
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["a private address", ["10.1.2.3"]],
    ["loopback", ["127.0.0.1"]],
    ["link-local cloud metadata", ["169.254.169.254"]],
    ["IPv6 loopback", ["::1"]],
    ["IPv6 link-local", ["fe80::1"]],
    ["IPv6 unique local", ["fd00::1"]],
    ["an IPv4-mapped private address", ["::ffff:10.0.0.1"]],
    ["one private address among public ones", ["142.250.80.10", "192.168.1.1"]],
    ["no address", []],
  ])("refuses an allowed host that resolves to %s", async (_name, addresses) => {
    await expect(checkOidcEndpoint(GOOGLE, GOOGLE_ENDPOINTS.token_endpoint, resolvesTo(...addresses))).rejects.toThrow("oidc_endpoint_not_public");
  });

  it("lists Google's endpoint hosts only, all under googleapis.com", () => {
    expect(Object.keys(OIDC_ENDPOINT_HOSTS)).toEqual([GOOGLE]);
    for (const host of OIDC_ENDPOINT_HOSTS[GOOGLE]) expect(host).toMatch(/\.googleapis\.com$/);
  });
});

describe("oidcFetch", () => {
  it("sends nothing to an allowed host that resolves to a private address", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(oidcFetch(GOOGLE, GOOGLE_ENDPOINTS.userinfo_endpoint, { headers: { accept: "application/json" } }, resolvesTo("10.0.0.5"))).rejects.toThrow("oidc_endpoint_not_public");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing to a host off the list", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(oidcFetch(GOOGLE, "https://evil.example.com/userinfo", {}, publicDns)).rejects.toThrow("oidc_cross_origin_endpoint");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses a plain fetch on the issuer's own origin", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await oidcFetch("https://idp.example.com", "https://idp.example.com/userinfo", { headers: { accept: "application/json" } });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe("publicAddresses", () => {
  it("returns public addresses and refuses private ones", async () => {
    await expect(publicAddresses("example.com", resolvesTo("93.184.215.14"))).resolves.toEqual([{ address: "93.184.215.14", family: 4 }]);
    await expect(publicAddresses("example.com", resolvesTo("172.16.0.1"))).rejects.toThrow("unsafe_url");
    await expect(publicAddresses("[::1]")).rejects.toThrow("unsafe_url");
  });
});

describe("oidcProvider", () => {
  it("names Google's issuer, with or without a trailing slash", () => {
    expect(oidcProvider("https://accounts.google.com")).toBe("google");
    expect(oidcProvider("https://accounts.google.com/")).toBe("google");
    expect(oidcProvider("https://idp.example.com")).toBe("oidc");
  });
});

describe("isPrivateAddress", () => {
  it.each(["8.8.8.8", "142.250.80.10", "2607:f8b0:4004:c1b::5f", "::ffff:8.8.8.8", "64:ff9b::808:808"])("treats %s as public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it.each([
    "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::", "::1", "fe80::1", "fd00::1", "ff02::1",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "not-an-address",
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });
});

describe("requestPinned", () => {
  it("sends the method, headers and body to the pinned address, whatever the host name resolves to", async () => {
    const { createServer } = await import("node:http");
    const { requestPinned } = await import("../lib/safe-fetch.js");
    let seen = { method: "", host: "", type: "", body: "" };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen = { method: req.method ?? "", host: req.headers.host ?? "", type: String(req.headers["content-type"]), body };
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const response = await requestPinned(new URL(`http://pinned.invalid:${port}/token`), {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "code=abc",
      }, [{ address: "127.0.0.1", family: 4 }]);
      expect(await response.json()).toEqual({ ok: true });
      expect(seen).toEqual({ method: "POST", host: `pinned.invalid:${port}`, type: "application/x-www-form-urlencoded", body: "code=abc" });
    } finally {
      server.close();
    }
  });
});
