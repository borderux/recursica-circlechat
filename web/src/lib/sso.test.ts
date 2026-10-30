import { describe, expect, it } from "vitest";
import { ssoButtons } from "./sso";

describe("ssoButtons", () => {
  it("shows Sign in with Google for a workspace with Google SSO turned on", () => {
    expect(ssoButtons([{ workspace: "acme", workspaceName: "Acme", provider: "google" }])).toEqual([
      { label: "Sign in with Google", href: "/api/auth/sso/acme" },
    ]);
  });

  it("shows no button when no workspace has SSO turned on", () => {
    expect(ssoButtons([])).toEqual([]);
    expect(ssoButtons(undefined)).toEqual([]);
  });

  it("names each workspace when more than one has SSO, and labels other providers plainly", () => {
    expect(ssoButtons([
      { workspace: "acme", workspaceName: "Acme", provider: "google" },
      { workspace: "beta", workspaceName: "Beta", provider: "oidc" },
    ]).map((button) => button.label)).toEqual(["Sign in with Google (Acme)", "Sign in with single sign-on (Beta)"]);
  });

  it("uses the api base and encodes the workspace handle", () => {
    expect(ssoButtons([{ workspace: "a b/c", workspaceName: "A", provider: "google" }], "https://chat.example.com/api/")[0].href)
      .toBe("https://chat.example.com/api/auth/sso/a%20b%2Fc");
  });
});
