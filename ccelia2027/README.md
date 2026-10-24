# Cela.sh

A read-only public-web research agent served by one Cloudflare Worker.

## Project Status

This repository contains a read-only Agent v1 implementation. Stubbed tests cover planning, public-web search, reading up to three pages in one short-lived Browser Run session, cancellation, and the free-tier safety budgets. Live Cloudflare/model/browser behavior has not been verified, and no production deployment was performed. Clear requests with explicit HTTPS URLs use a deterministic plan; other tasks use Workers AI by default. NVIDIA NIM can be selected for local development; a separate manual GitHub Actions workflow can make one synthetic API test. The Arabic Cela.sh interface keeps conversation history in this browser's local storage and can download HTML, Markdown, and CSV reports.

This is not unrestricted computer control. It cannot log into websites, click, type, submit forms, send, delete, purchase, or change data. It can only search public results or open up to three supplied public HTTPS pages, read extracted text, and summarize it. Direct-URL plans and model-generated plans use the same strict schema validation; unsupported or malformed model plans stop before browser execution. The user can cancel a run; cancellation closes the browser and releases its concurrency slot, but the conservative two-minute internal daily reservation remains counted.

The UI includes an optional business-research path tailored to apparel/textile design: validate demand for print-placement and production-spec services, research public prices before drafting service tiers, test demand for digital templates, or identify public company leads. It also researches AI pattern generation and prompt writing, fashion mockups, print-file optimization, public trend signals, and store personalization. These are research prompts only; the app does not generate or edit images, verify print readiness, promise income, contact prospects, publish offers, or process customer files. Tool features, licenses, and prices must be verified from current public sources before purchase or commercial use.

## Vision

Build an automation platform with clear security boundaries, testable components, and deployment paths that can grow as requirements become concrete.

## Architecture

- `src/`: Worker API and daily-budget Durable Object.
- `tests/`: Node built-in tests for schema validation, access control, quotas, and the Playwright session contract.
- `docs/`: architecture, deployment, security notes, and Worker-served static assets.
- `.github/workflows/`: CI, CodeQL, Pages, Cloudflare deployment, and container workflows.
- `.devcontainer/`: reproducible Codespaces and VS Code environment.

The Worker serves the UI at `/`, health at `/health`, and secured `/api/*` routes. The default deployment uses Workers AI and does not need an external model key. NVIDIA NIM is an optional local-development provider; a manual smoke test can use the repository secret without passing it to the Worker. NIM is not enabled in the deployment configuration. A SQLite-backed Durable Object stores only rolling daily usage counters.

## Quick Start

Requirements: Node.js 22 and npm.

```sh
npm ci
npm run dev
```

In another terminal, check `http://localhost:8787/health`. A live Browser Run session requires a Cloudflare account and consumes its free allowance. Unit tests use stubs and are not a live-service check.

To configure local secrets:

```sh
cp .dev.vars.example .dev.vars
```

Replace the example password and session secret. For optional local NVIDIA NIM testing, set `AI_PROVIDER="nvidia"` and add your NVIDIA API key and model to `.dev.vars`. Never commit `.dev.vars`.

## Optional Local NVIDIA NIM

NVIDIA's developer API access is intended for prototyping, development, and testing; it is not a free production service for real end users. Rate limits depend on the model and account. When NIM is selected locally, task text and extracted webpage text are sent to NVIDIA for planning or summarization. A quota or provider error stops the request; there is no automatic fallback. The manual GitHub smoke test sends only a fixed synthetic prompt and suppresses response content. The production Worker defaults to Cloudflare Workers AI and never receives the repository's `NVIDIA_API_KEY` secret.

## Development

```sh
npm run lint
npm run format:check
npm test
npm run build
npm audit --audit-level=high
```

See [Development](docs/development.md) for workflow details.

## Deployment

- **Cloudflare Worker:** one manual-only workflow serves UI and API on `workers.dev`. It requires a verified Workers Free account, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `APP_ACCESS_PASSWORD`, and a random `SESSION_SECRET` of at least 32 characters. The workflow checkbox is operator attestation, not an independent billing check.
- **GitHub Pages:** no longer deploys this app because Pages would not provide its same-origin Worker API.
- **Container:** the GHCR workflow builds on demand and publishes only for a published GitHub Release. The image is a local Worker development environment, not a Cloudflare production runtime.

See [Deployment](docs/deployment.md).

Read [Free-tier limits](docs/free-tier.md) before using or deploying. Do not deploy if the Cloudflare account is Paid or has billing enabled.

## Security

Read [SECURITY.md](SECURITY.md). Never commit credentials, API keys, `.dev.vars`, or production data. Security vulnerabilities must be reported privately.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Pull requests should include tests and pass the required checks.

## License

This component is covered by the repository-root MIT license.

## Roadmap

1. Confirm product requirements and licensing.
2. Define the agent/runtime boundary and threat model.
3. Add one focused capability at a time with tests and documented deployment behavior.
