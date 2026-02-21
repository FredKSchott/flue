# Flue Messaging Framework

Reference document for all public-facing copy — READMEs, landing page, social, docs.

---

## Headline

**Flue — The Sandbox Agent Framework**

## Tagline

**Build AI agents that can safely run code, triage issues, review PRs, and more — powered by OpenCode, running on your infrastructure.**

## Elevator Pitch

> Flue is a TypeScript framework for building AI agents that operate inside secure sandboxes. Write your orchestration in TypeScript, delegate tasks to AI via OpenCode, and deploy anywhere — Docker, GitHub Actions, or Cloudflare. Stop paying for AI dev tools you can build, own, and customize yourself.

---

## Supporting Pillars

### 1. Sandbox-first security

AI agents run in isolated containers. Credentials are injected via proxy — never exposed to the LLM. Even a compromised agent can't access your tokens or escape the sandbox.

### 2. TypeScript-native SDK

Flue workflows are TypeScript — with full type safety, autocomplete, and intellisense. The `FlueClient` gives you a typed API for working with sandboxes powered by OpenCode. No YAML. No config files. Just TypeScript.

### 3. Powered by OpenCode

Every agent session has full access to OpenCode's capabilities — file editing, terminal commands, web browsing, and more. You get a production-grade coding agent without building one from scratch.

### 4. Powered by skills

Skills are markdown instructions that teach AI agents how to work with _your_ codebase. They're the secret to why Flue workflows outperform generic AI tools — because you encode your team's actual expertise.

### 5. Run anywhere, own everything

`@flue/cli` runs workflows locally in Docker or in GitHub Actions. `@flue/cloudflare` runs the same workflows on Cloudflare's edge using Containers, Durable Objects, and Workers. Same workflow, different runtime. You pick the infrastructure.

---

## "Build Your Own X" (landing page block / social hook)

> Why pay for AI dev tools you could build yourself?

- **AI Issue Triage** — like what Astro runs in production
- **AI Code Review** — your own CodeRabbit, customized to your standards
- **AI Test Generation** — agents that write and run tests in a real environment
- **AI PR Agent** — responds to comments, implements feedback, pushes fixes
- **General-purpose AI Agent** — your own Devin, scoped to your repo

> Each of these is a Flue workflow. TypeScript orchestration + markdown skills. Reusable across repos. Customizable to yours.

---

## Key Differentiator Statement

> Every AI dev tool — CodeRabbit, Devin, and the rest — is really just a workflow running an LLM against your code in a sandbox. You're paying a middleman for code and infrastructure you could own. And worse, you can't customize it. We built Astro's issue triage bot with Flue — it outperforms every third-party tool we tried, because the skills encode how _we_ debug Astro, not some generic heuristic. Flue gives you the same pattern as a TypeScript framework: define the workflow, write the skills, deploy to your infra.

---

## Reusable Workflows

> Flue workflows are portable. Anyone can take a triage workflow from one repo and drop it into another. The workflow script is the reusable scaffolding — reproduce, diagnose, fix, comment. The skills are what you customize, written in markdown, encoding your team's expertise. That's the part that was always going to be custom anyway.

---

## How This Maps to Deliverables

| Deliverable                         | What it uses from above                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| **Root README**                     | Headline + Tagline + Elevator Pitch + Pillars (condensed) + Quick Start |
| **Package READMEs**                 | Tagline + relevant pillar + API docs                                    |
| **Landing page hero**               | Headline + Tagline + CTA                                                |
| **Landing page body**               | Pillars (expanded) + "Build Your Own X" + Code examples                 |
| **Landing page footer/positioning** | Key Differentiator Statement                                            |
| **Twitter/social**                  | "Build Your Own X" hooks + one-liner variants                           |
| **Blog (launch post)**              | Full narrative: differentiator + Astro story + pillars                  |

---

## Future Content Ideas

Ideas that didn't fit the core messaging framework but are worth developing as standalone content (blog posts, landing page sections, Twitter threads, etc).

### Skills as a new primitive

Skills (markdown instructions that encode team expertise) are a genuinely new primitive that will change how people customize developer tools. The bigger story: skills replace SaaS configuration UIs. They're the part that _always had to be custom_ — how your team does triage is fundamentally different from how another team does triage. This flips the model from "sign up for a service and configure it" to "write your expertise in markdown and plug it into a reusable workflow." Could be a standalone blog post or a dedicated landing page section.

### The Astro case study

A real open source project running Flue in production, outperforming every third-party AI triage tool they tried. For the landing page and launch blog, leading with this as a concrete case study could be very powerful. "Here's what Astro built. Here's what it replaced. Here's the code." Show the actual workflow, the actual skills, the actual results.

### "AI makes code cheap — build your own tools"

AI is making code cheaper to write, so "build your own Devin" is actually not a huge ask anymore. The era of paying startups to wrap LLMs for you is ending. Frameworks like Flue are why. Provocative framing for a blog post or Twitter thread. Too spicy for a README, perfect for content.

### Proxies as a standalone feature

The proxy system (credential injection, policy-based access control, rate limits per rule, body validation, path matching) is genuinely sophisticated and unique. For security-conscious teams, this could be its own selling point: "Define exactly what your AI agent can access, down to the HTTP method and path. Rate-limit actions. Block mutations. All declarative." Could be a deep-dive blog post or docs page.

### "Headless OpenCode"

Flue is effectively headless OpenCode — it takes a tool designed for interactive use and makes it programmable and deployable. For people who already use and love OpenCode, this is a very direct pitch: "You know OpenCode? Now make it run autonomously, in a sandbox, triggered by events." Good framing for the OpenCode community specifically.
