---
title: Braintrust
description: Trace Flue agent operations, model turns, tools, tasks, and compactions in Braintrust.
lastReviewedAt: 2026-08-05
---

## Quickstart

Add [Braintrust](https://www.braintrust.dev) tracing to an existing Flue project:

```sh
flue add tooling braintrust
```

Then set your credentials and start the application normally:

```sh
export BRAINTRUST_API_KEY='<braintrust-api-key>'
export BRAINTRUST_PROJECT_NAME='Flue'
```

`BRAINTRUST_PROJECT_NAME` is optional and defaults to `Flue`. Keep the API key in your deployment platform's secret store; on Cloudflare, use a Worker secret rather than a Wrangler `vars` value. EU and self-hosted organizations should also set `BRAINTRUST_API_URL` to the API URL shown under **Settings → Data plane**. See Braintrust's [tracing quickstart](https://www.braintrust.dev/docs/tracing-quickstart) for account and API-key setup.

## How it works

The blueprint installs the Braintrust SDK, creates `braintrust.ts` beside `app.ts`, and imports it once from `app.ts`. The generated module uses the first-class integration provided by current Braintrust releases:

```ts title="src/braintrust.ts"
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

The instrumentation connects Braintrust to both Flue's runtime events and execution context, keeping the active Braintrust span available during model, tool, and task execution. No event adapter, provider wrapper, or Node import hook is needed. When the API key is absent, Braintrust is not initialized and the application continues without exporting traces.

The same module works across all Flue runtimes.

## What gets traced

| Flue activity      | Braintrust span                                     |
| ------------------ | --------------------------------------------------- |
| Prompt or skill    | `flue.prompt` or `flue.skill` task span             |
| Model turn         | `flue.turn` LLM span with output, usage, and errors |
| Tool call          | `tool:<name>` tool span                             |
| Delegated task     | `task:<agent>` or `flue.task` task span             |
| Context compaction | `flue.compact` with a `compaction:<reason>` child   |

Spans include the available Flue correlation fields, such as agent, instance, conversation, harness, session, submission, operation, turn, and task identifiers. A prompt with a tool call typically looks like this:

```text
flue.prompt
  flue.turn
  tool:lookup_weather
  flue.turn
```

Braintrust records production traces in a project's **Logs** view. Tracing and evaluation are complementary: traces show what the application did, while eval cases add datasets, expectations, and scores. To publish [`vitest-evals`](/docs/ecosystem/tooling/vitest-evals/) cases as Braintrust experiments, use Braintrust's `vitest-evals` reporter.

## Protect sensitive content

This integration is content-bearing. It can export messages and model output, reasoning, system prompts, tool definitions, arguments and results, task content, errors, and correlation metadata.

Review access and retention requirements before enabling it in production. If content needs redaction, call Braintrust's `setMaskingFunction(...)` before `initLogger(...)`. The function is global and masks `input`, `output`, `expected`, `metadata`, and `context`; test it against representative application data. See Braintrust's guide to [masking sensitive data](https://www.braintrust.dev/docs/instrument/advanced-tracing#mask-sensitive-data).

## Cloudflare delivery

Braintrust buffers and uploads spans in the background. Node.js gets Braintrust's best-effort `beforeExit` flush. In a Cloudflare Worker, the Flue integration cannot attach the SDK's final background upload to the Durable Object's execution lifetime, so the last spans can be lost if an isolate becomes idle immediately after an operation.

Verify delivery in a deployed Worker before relying on these traces. Braintrust's [background logging guide](https://www.braintrust.dev/docs/instrument/advanced-tracing#background-logging-and-retries) explains its buffering and retry behavior.

## Verify

Run a prompt that calls a tool against a non-production Braintrust project. In **Logs**, confirm that:

- `flue.prompt` contains the model and tool spans;
- the final model and tool spans close and contain the expected output;
- token usage and Flue correlation fields are present;
- the application still starts when `BRAINTRUST_API_KEY` is unset.

See [Observability](/docs/guide/observability/#choose-an-observability-provider) to compare Braintrust with OpenTelemetry and Sentry.
