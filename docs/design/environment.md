# Build environment — verified capabilities

Measured 2026-09-21 in the Claude Code remote environment used to build Shepard.
These are observations, not assumptions; re-check them if the environment changes.

## Available

| Capability | Result |
|---|---|
| Node | v22.22.2, npm 10.9.7, pnpm 10.33.0 |
| Python | 3.11.15 |
| Playwright | 1.56.1 global, Chromium at `/opt/pw-browsers` |
| Browser verification | **Works.** Launched Chromium headless against a local page, clicked a control, captured console errors, captured a 404 network failure, wrote a screenshot |
| PostgreSQL | Server binaries at `/usr/lib/postgresql/16/bin`, client 16.13 — a local database can be provisioned |
| Local networking | Binding and serving on localhost works |
| GitHub | `api.github.com` reachable, token present |
| Package registries | npm, PyPI, crates, Go proxy reachable |
| Resources | 4 CPU, 15 GB RAM, ~30 GB writable disk |

The full verification stack Shepard depends on — boot an app locally, drive it in a
real browser, observe console and network, assert against a local database — is
available here.

## Constraints

**No Anthropic API key.** `api.anthropic.com` returns 401. This session's own model
access is proxied and is not available to a program Shepard runs. Shepard needs its
own key to execute its loop.

**Egress is a strict allowlist.** `CONNECT` is refused for hosts outside GitHub and
the package registries — `example.com`, `vercel.com` and `supabase.com` are all
rejected by organisation policy. Shepard running in this environment cannot reach an
arbitrary deployed application.

This reinforces the architecture rather than fighting it: verification targets an
ephemeral instance built from source, which needs no outbound access. Any future
production liveness probe would require the environment's network policy to be
widened deliberately.

**No Docker daemon.** The CLI and Compose plugin are installed but
`/var/run/docker.sock` does not exist. Isolation here is process-level. Design for
containers; run without them in this environment.

**No Supabase or Vercel CLI**, and no hosting credentials present.
