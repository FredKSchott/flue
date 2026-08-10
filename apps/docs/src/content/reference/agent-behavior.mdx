---
title: Agent Behavior
description: How an agent behaves when you run it — the default tools, environment, message handling, context rules, and limits, in one place.
---

This page describes what a Flue agent does out of the box: the tools the model
gets, what environment it runs in, how incoming messages are handled, what its
context window contains, and the limits the runtime enforces. It is a map of
runtime behavior, not an authoring API — the pages that define these behaviors
are linked from each section. Flue's inner agent loop builds on
[pi's](https://pi.dev) agent core; everything below is Flue's own contract, and
where you want the pi coding agent's equivalents, see
[pi's usage docs](https://pi.dev/docs/latest/usage).

## Built-in tools

An agent with a [sandbox](/docs/guide/sandboxes/) attached gets six tools that
operate on it. These are the tools the model calls — application code and
sandbox adapters use the [`Sandbox`](/docs/reference/sandbox-api/#sandbox)
surface these tools are built on, which is deliberately lower-level
(whole-file verbs, no truncation).

### `read`

Reads a file. Parameters: `path`, optional `offset` (line number to start
from, 1-indexed), optional `limit` (maximum lines).

- Output is truncated to **2000 lines or 50 KB**, whichever is hit first, and
  never mid-line. Truncated output ends with a marker naming the shown range
  and the offset to continue from (`Use offset=N to continue.`), so the model
  can page through files of any length.
- An `offset` past the end of the file is an error naming the file's actual
  line count.
- A single line larger than the byte budget is surfaced as its first 50 KB
  with a note that the remainder is not reachable via `offset`/`limit`.

### `write`

Writes a file whole. Parameters: `path`, `content`. Creates the file and any
missing parent directories; overwrites silently when the file exists.

### `edit`

Exact-text replacement. Parameters: `path`, `oldText`, `newText`, optional
`replaceAll`.

- `oldText` must match exactly one region of the file: zero matches is an
  error telling the model to check whitespace and indentation; multiple
  matches is an error asking for more surrounding context — unless
  `replaceAll` is set, which replaces every occurrence and reports the count.
- The read → replace → write transaction is atomic per file: tool calls in
  one batch run in parallel, and same-file mutations from `write` and `edit`
  are serialized through a per-path lock so a genuine conflict surfaces as a
  "could not find" error instead of a silently lost edit. A `bash` command
  mutating the same file concurrently is not synchronized.

### `bash`

Executes a shell command in the sandbox. Parameters: `command`, optional
`timeout` (seconds).

- Returns combined stdout/stderr, truncated to the **last** 2000 lines or
  50 KB (the tail is where errors and final results live). A non-zero exit
  appends the exit code.
- A command that exceeds `timeout` returns a recoverable exit-124 result
  rather than failing the operation, so the model can react.

### `grep`

Searches file contents. Parameters: `pattern` (regex), optional `path`,
`include` (glob filter), `literal`.

- Runs `rg` inside the sandbox when available (probed once), falling back to
  POSIX `grep -E`.
- Returns matching lines with file paths and line numbers, capped at **100
  matches** and **500 characters per line**; hitting the cap is reported with
  advice to narrow the search.

### `glob`

Finds files by name. Parameters: `pattern`, optional `path`. Uses shell
`find -name` semantics — the pattern matches file names, not paths — and
returns up to **1000** paths.

### Framework tools

Independent of any sandbox, the framework adds its own tools when the
capability exists: `task` for [subagent delegation](/docs/guide/subagents/)
(always present; inert until agents are declared), `activate_skill` when the
agent has [skills](/docs/guide/skills/), and `read_skill_resource` when an
imported skill packages resource files. These names are reserved — a custom
tool can't take them.

A sandbox adapter may replace the six sandbox tools with its own set — see
[Sandbox-provided tools](/docs/guide/sandboxes/#sandbox-provided-tools) —
so check an integration's documentation before assuming ordinary file or
command tools are present.

## Environment defaults

An agent has **no sandbox unless you attach one** with
[`useSandbox()`](/docs/reference/agent-hooks-api/#usesandbox), and at most
one. Without a sandbox: the six file and shell tools aren't in the tool set,
no workspace context enters the system prompt, workspace skills aren't
discovered, and [`harness.sandbox`](/docs/reference/agent-api/#harnesssandbox)
throws. Everything else — custom tools, imported skills, subagents, state —
works the same either way.

Attaching one defines several behaviors at once (tools, workspace discovery,
skills, what subagents inherit) — the [Sandboxes
guide](/docs/guide/sandboxes/#what-a-sandbox-adds) walks through them.
Presence is re-read at every turn boundary, so a conditional `useSandbox()`
can attach or detach the environment mid-conversation; the swap is narrated
to the model as an [`environment`
signal](/docs/reference/agent-api/#dynamic-resources).

## Message handling

Every input — HTTP prompt, `dispatch()`, channel delivery, scheduled trigger
— is admitted as a **submission**, recorded durably before any model work
begins. Submissions for one conversation form a queue processed in admission
order, and the agent does not sit idle behind a busy conversation's turn:

- One submission runs at a time.
- A message that arrives while the agent is busy **joins the live response at
  the next turn boundary** when it can, and otherwise waits its turn as its
  own submission. Nothing is dropped: a delivery that misses the live
  response runs on its own afterward.
- Every accepted submission reaches exactly one durable terminal outcome —
  `completed`, `failed`, or `aborted` — no matter how many crashes happen in
  between.

Retries, recovery, and abort mechanics are the [Durability
guide](/docs/guide/durability/)'s territory; the wire contract (the `202`
admission response, streaming) is in [Routing](/docs/guide/routing/).

## Context composition

At initialization the runtime composes the system prompt from what it finds:
the agent function's returned instructions, and — when a sandbox is attached
— the working directory path, a directory listing, the contents of
`AGENTS.md` when present, plus the discovered skill, subagent, and tool
rosters.

The system prompt is then **frozen**: it keeps describing the workspace and
catalogs discovered at initialization until the next compaction rebaselines
it against the current environment. Mid-window changes — tools mounting or
unmounting, skills flipping, the environment swapping — are narrated to the
model as append-only [signals](/docs/reference/agent-api/#dynamic-resources)
instead of prompt rewrites, which keeps the transcript's earlier turns
consistent with the prompt they actually ran under (and keeps the system
prompt's share of the provider's prompt cache warm, though a tool change
invalidates the cache through the native tools array).

## Context management

When the conversation approaches the model's context window, the runtime
compacts: older messages fold into a summary and recent ones are preserved
verbatim. Threshold compaction triggers when used tokens exceed the window
minus a model-aware reserve (capped at 20,000 tokens); the most recent 8,000
tokens are kept verbatim by default. Both knobs, the summarization model, and
opting out are [`CompactionConfig`](/docs/reference/agent-hooks-api/#compactionconfig);
overflow recovery and explicit
[`harness.compact()`](/docs/reference/agent-api/#harnesscompact) compact even
when threshold compaction is disabled.

## Limits

The numbers the runtime enforces, collected from the sections above plus the
delegation machinery:

| Limit                          | Value                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `read` output                  | 2000 lines / 50 KB, head-truncated with continuation marker                                                |
| `bash` output                  | 2000 lines / 50 KB, tail-truncated                                                                         |
| `grep` results                 | 100 matches, 500 chars per line                                                                            |
| `glob` results                 | 1000 paths                                                                                                 |
| Delegation depth               | 4 — a `task` chain (including harness invocations) deeper than this fails with `delegation_depth_exceeded` |
| Compaction reserve             | model-aware, capped at 20,000 tokens                                                                       |
| Kept verbatim after compaction | 8,000 tokens by default                                                                                    |

Tool-set size has no framework cap, but every mounted tool spends context —
see [Conditional tools](/docs/guide/tools/#conditional-tools) for keeping the
set lean.
