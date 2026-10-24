# Security Overview

The runtime is a read-only public-web agent. It accepts tasks after shared-password login. Clear requests to read one explicit HTTPS URL use a deterministic planner; other tasks and extracted public-page text are sent to the configured model provider. Workers AI is the default; optional local NVIDIA NIM sends the same inputs to NVIDIA. The server does not retain task text. Conversation history stays in browser local storage. The Durable Object retains only the current daily usage counters.

## Baseline

- CI workflows declare only the permissions they need.
- CodeQL scans JavaScript on pushes, pull requests, and a weekly schedule.
- Dependabot checks npm, GitHub Actions, and devcontainer dependencies.
- Secret scanning and push protection are enabled only when GitHub confirms support for this public repository.
- `APP_ACCESS_PASSWORD` and `SESSION_SECRET` are Cloudflare Worker Secrets; CI values belong in GitHub Actions secrets. Local Wrangler values belong in ignored `.dev.vars` files.
- NVIDIA NIM is opt-in for local development. Its local API key belongs in ignored `.dev.vars`; local tasks and page text sent while it is selected leave this application and are processed under NVIDIA's terms. The separate manual GitHub smoke test uses the repository secret only for one fixed synthetic prompt, does not log the response, and never passes the key to the Worker.
- Authentication fails closed unless both app secrets, the selected model provider, Browser Run, and budget bindings are available. The default provider requires the Workers AI binding; local NIM requires its API key. Cookies are signed, Secure, HttpOnly, and SameSite=Strict.
- Login attempts are rate-limited. Plans are schema-validated and signed for five minutes; client-edited plans are rejected.
- Before Browser Run is reserved, the Worker checks the target's A and AAAA records through Cloudflare DNS-over-HTTPS and rejects the request unless every answer is public IPv4 or globally routable IPv6. Playwright uses a fresh context with no persisted cookies, JavaScript and service workers disabled, and a route guard allowing only same-origin HTTPS GET/HEAD requests; downloads, scripts, images, media, and fonts are blocked.
- Sensitive requests need a separate read-only confirmation. The browser executor has no form submission or state-change action.

## Reporting

Read [SECURITY.md](../SECURITY.md). Do not put vulnerability details in public issues.

## Current Limitations

This is not a general-purpose network sandbox. The DNS check and Browser Run's later DNS resolution are separate, so DNS rebinding is not fully excluded; the route guard is defense-in-depth, not a guarantee that private-network access is impossible. The browser only makes GET/HEAD requests, but a poorly designed site can still perform a state change on a GET URL; only provide links intended for public reading. Browser tasks stop after 45 seconds and reserve 120 seconds of daily browser budget to cover the 60-second inactivity cleanup window after a failed close. Browser Run performs the remote navigation and website behavior can change. JavaScript-disabled mode may not show content rendered only by scripts. Do not provide account credentials or use private sites. App-level quota caps do not prove the Cloudflare account billing plan; deployment must be withheld unless the dashboard confirms Workers Free and no billing method/profile.
