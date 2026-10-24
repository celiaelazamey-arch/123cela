# Architecture

## Current MVP

```text
Browser (Cela.sh interface; history in localStorage; HTML/Markdown/CSV report downloads)
  -> one Cloudflare Worker (static assets + API)
      -> direct-URL rule for clear read tasks with up to 3 supplied links OR configured model provider for other plans
      -> strict CELA-shaped schema + deterministic policy
      -> signed, short-lived read-only plan token
      -> Durable Object: serialized daily safety-budget reservation
       -> Browser Run / Playwright: one isolated session, public search or up to 3 public pages + extraction
       -> configured model provider: summarize labeled source evidence
```

Direct-URL plans require one to three explicit public HTTPS URLs and a clear read-only request; they skip planner AI, then pass through the same schema validator and signed-token flow. Search plans read at most three DNS-validated public results. Both routes use one short-lived Browser Run session per task, with the allowed origin updated only for the page currently being read. Each captured source includes its title, URL, read timestamp, and excerpt; reports can be downloaded as HTML, Markdown, or CSV. The UI also offers apparel/textile business-research prompts for demand validation, service packaging, digital-template research, public company leads, AI pattern tools and prompt writing, fashion mockups, print optimization, trend research, and store personalization. These remain research only: no images are generated or edited, no artwork is uploaded, no print-readiness guarantee or income promise is made, and no prospect or store is contacted. Tool features, commercial rights, and prices must be checked against current public sources. Workers AI is the default model provider. NVIDIA NIM is optional for local development only and requires a user-supplied key kept in ignored `.dev.vars`; no NIM key or fallback is configured for production. The SQLite-backed Durable Object keeps only one day's counters. Each task gets a fresh browser context with no saved cookies; page JavaScript and service workers are disabled, and the session cannot click, type, submit forms, download files, or access authenticated accounts. Cancelling a run closes the context/browser and releases its concurrency slot; the reserved daily browser allowance is not refunded.

## Safety Boundaries

- Model output is strictly parsed; only NAVIGATE/SEARCH_WEB followed by OBSERVE is accepted.
- Every target requires HTTPS and public DNS answers. Playwright permits only same-origin HTTPS GET/HEAD requests for the current source and blocks downloads, scripts, images, media, fonts, and service workers.
- Sessions use signed, HttpOnly, Secure, same-site cookies. API routes fail closed when secrets or bindings are missing.
- Sensitive wording requires explicit confirmation, but the executor remains read-only even after confirmation.
- Internal daily limits stay under the documented Free ceiling: at most 5 Browser Run sessions (120,000 reserved ms each = a conservative 10-minute worst-case day), no more than 3 concurrent reservations, and a 20-second interval between starts; plus 28 AI calls (up to 9,800 estimated Neurons/day). Reading several sources in one task still consumes one browser-session reservation.
- Deployment is manual only. Billing status is not automatically queried; verify Workers Free and no billing before dispatch.
