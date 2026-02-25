# Astro Triage (Cloudflare)

Automated GitHub issue triage for the [withastro/astro](https://github.com/withastro/astro) repository. Deployed as a Cloudflare Worker, it listens for new issues via webhook, spins up a sandbox, and uses Flue to reproduce, diagnose, and optionally fix reported bugs.

See the [Deploy on Cloudflare](../../docs/deploy-cloudflare.md) guide to learn how to build and deploy your own Flue workflow on Cloudflare Workers.
