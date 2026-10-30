// The login page's sign-in buttons, one for each workspace with SSO turned on.
// GET /api/auth/sso-options lists them; each button starts the workspace's
// sign-in at /api/auth/sso/<workspace handle>.
export interface SsoOption {
  workspace: string;
  workspaceName: string;
  provider: "google" | "oidc";
}

export interface SsoButton {
  label: string;
  href: string;
}

export function ssoButtons(options: SsoOption[] | undefined, apiBase = "/api"): SsoButton[] {
  const list = options ?? [];
  const base = apiBase.replace(/\/+$/, "");
  return list.map((option) => {
    const label = option.provider === "google" ? "Sign in with Google" : "Sign in with single sign-on";
    return {
      // With more than one workspace, each button names its own.
      label: list.length > 1 ? `${label} (${option.workspaceName})` : label,
      href: `${base}/auth/sso/${encodeURIComponent(option.workspace)}`,
    };
  });
}
