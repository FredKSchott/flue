---
{ "kind": "tooling", "version": 1, "website": "https://www.braintrust.dev" }
---

# Add Braintrust to Flue

You are an AI coding agent adding Braintrust tracing to a Flue project. Use
Braintrust's first-class Flue instrumentation with Flue's `instrument(...)`
API. The same application source must work across all Flue runtimes.

## Inspect the project

Read local instructions, detect the package manager, and select the first
existing source root: `<root>/.flue/`, then `<root>/src/`, then `<root>/`.
Inspect `app.ts`, deployment configuration, environment types, and the
project's secret conventions before editing them.

Install the latest stable `braintrust` version allowed by the project's
dependency policies. The integration below requires Braintrust 3.27.0 or
newer for Flue 2 support. Preserve the Flue target and existing dependency
conventions.

## Configure Braintrust

Use these variables unless the project already has a Braintrust convention:

| Variable                  | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `BRAINTRUST_API_KEY`      | Braintrust API key; keep it in the deployment platform's secret store. |
| `BRAINTRUST_PROJECT_NAME` | Project receiving traces; defaults to `Flue`.                          |
| `BRAINTRUST_API_URL`      | API URL for EU or self-hosted data planes; omit for the US default.    |

Never invent or commit an API key. Update an existing `.env.example`,
environment type, or deployment guide when the project maintains one. On
Cloudflare, store `BRAINTRUST_API_KEY` as a Worker secret rather than a
Wrangler `vars` value.

Braintrust exports model messages and output, reasoning, system prompts, tool
definitions, tool arguments and results, task content, errors, and correlation
metadata. Confirm that this data may leave the application. If it requires
redaction, configure and test Braintrust's global `setMaskingFunction(...)`
before `initLogger(...)`.

## Add the instrumentation

Create `<source-dir>/braintrust.ts`:

```ts title="src/braintrust.ts"
// flue-blueprint: tooling/braintrust@1
import { instrument } from '@flue/runtime';
import { braintrustFlueInstrumentation, initLogger } from 'braintrust';

const apiKey = process.env.BRAINTRUST_API_KEY;

if (apiKey) {
  initLogger({
    projectName: process.env.BRAINTRUST_PROJECT_NAME ?? 'Flue',
    apiKey,
  });

  instrument(braintrustFlueInstrumentation());
}
```

Import the module once from source-root `app.ts`:

```ts
import './braintrust.ts';
```

Preserve the application's existing imports, middleware, routes, and default
export. The explicit Flue instrumentation covers the framework across all Flue
runtimes. It installs both the observer and an execution interceptor so the
active Braintrust span follows model, tool, and task execution. Current
Braintrust releases consume Flue 2 events, including terminal `tool` events,
directly.

When `BRAINTRUST_API_KEY` is absent, the module leaves Braintrust uninitialized
and continues without exporting traces.

## Runtime behavior

The instrumentation produces:

| Flue activity      | Braintrust span                                     |
| ------------------ | --------------------------------------------------- |
| Prompt or skill    | `flue.prompt` or `flue.skill` task span             |
| Model turn         | `flue.turn` LLM span with output, usage, and errors |
| Tool call          | `tool:<name>` tool span                             |
| Delegated task     | `task:<agent>` or `flue.task` task span             |
| Context compaction | `flue.compact` with a `compaction:<reason>` child   |

Braintrust buffers uploads in the background. Node receives its best-effort
`beforeExit` flush. On Cloudflare, the integration cannot attach the SDK's
final background upload to the Durable Object execution lifetime, so final
span delivery is best-effort. Tell the user about this limitation and verify
it in a deployed Worker when Cloudflare is a target.

## Verify

1. Type-check the project and build every supported target.
2. Exercise a prompt with a tool call in a non-production Braintrust project.
3. Confirm `flue.prompt` contains closed `flue.turn` and `tool:<name>` spans,
   token usage, and Flue correlation fields.
4. Run without `BRAINTRUST_API_KEY` and confirm the application still starts.
5. Inspect representative trace content and verify the masking, retention, and
   access decision.

## Upgrade Guide

### Version 1 — 2026-06-15

Initial version.
