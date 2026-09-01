---
title: boxd
description: Connect a Flue agent to an application-owned boxd Linux machine.
lastReviewedAt: 2026-09-01
---

The boxd adapter adapts an already-created boxd machine, driven through the `Boxd` client from `@boxd-sh/sdk`, into Flue's sandbox interface. Use it when an agent needs a provider-backed Linux virtual machine with filesystem and shell behavior rather than the lightweight default workspace.

## Quickstart

Add provider-backed Linux VM sandbox capability to an existing Flue project with the [boxd](https://boxd.sh) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox boxd
```

## Overview

The boxd blueprint installs `@boxd-sh/sdk` (0.2 or later) when needed and creates `sandboxes/boxd.ts` in your source-root. The generated adapter accepts an application-created `Boxd` client and machine; it does not create, retain, or delete the machine.

```ts title="<source-root>/sandboxes/boxd.ts (abridged)"
// flue-blueprint: sandbox/boxd@2
import { sandboxFromDriver, SandboxDiedError } from '@flue/runtime';
import type { SandboxDriver, SandboxFactory, Sandbox, FileStat } from '@flue/runtime';
import type { Boxd, Machine } from '@boxd-sh/sdk';

export interface BoxdAdapterOptions {
  cwd?: string;
  readyTimeoutMs?: number;
}

async function waitForReady(client: Boxd, machineId: string, timeoutMs: number): Promise<void> {
  /* Polls machines.exec(['true']) until the machine is ready or the deadline passes. */
}

function raceVmDeath<T>(
  client: Boxd,
  machineId: string,
  operation: string,
  call: Promise<T>,
): Promise<T> {
  /* Watches control-plane status while a call is in flight; rejects with
     SandboxDiedError when the machine reaches a terminal state. */
}

class BoxdSandboxDriver implements SandboxDriver {
  constructor(
    private client: Boxd,
    private machineId: string,
  ) {}

  /* Maps readFile/writeFile to machines.files.download/upload. */

  /* Implements stat, readdir, exists, mkdir, and rm with quoted shell utilities. */

  /* Runs commands through bash -lc and forwards env and timeouts unchanged. */
}

export function boxd(
  client: Boxd,
  machine: Machine | string,
  options?: BoxdAdapterOptions,
): SandboxFactory {
  const machineId = typeof machine === 'string' ? machine : machine.id;
  let readyPromise: Promise<void> | undefined;
  return {
    async createSandbox(): Promise<Sandbox> {
      const sandboxCwd = options?.cwd ?? '/home/boxd';
      readyPromise ??= waitForReady(client, machineId, options?.readyTimeoutMs ?? 30_000);
      await readyPromise;
      const driver = new BoxdSandboxDriver(client, machineId);
      return sandboxFromDriver(driver, sandboxCwd);
    },
  };
}
```

Passing `boxd(client, machine)` as an agent's `sandbox` waits for that machine's exec endpoint once, then exposes its files and Linux shell through Flue. Relative paths resolve from `/home/boxd` unless you set `cwd`; command timeouts remain in milliseconds, `stat` validates GNU metadata output, and `rm` receives the requested recursive and force flags, while machine identity, credentials, networking, persistence, and cleanup remain application-owned. While a call is in flight the adapter watches the machine's control-plane status through the same client and fails fast with `SandboxDiedError` if the machine is destroyed, stopped, or failed.

## Configure

| Variable       | Purpose                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `BOXD_API_KEY` | **Alternative authentication** — Authenticates with boxd when a short-lived token is not used.                     |
| `BOXD_TOKEN`   | **Alternative authentication** — Provides provider-supported short-lived authentication instead of `BOXD_API_KEY`. |

| Requirement                 | Purpose                                                               |
| --------------------------- | --------------------------------------------------------------------- |
| One boxd credential         | **Required** — Uses either `BOXD_API_KEY` or `BOXD_TOKEN`.            |
| `@boxd-sh/sdk` package      | **Required** — Creates the Linux machine adapted to `SandboxFactory`. |
| Application-owned lifecycle | **Required** — Creates, reuses, and deletes the machine.              |

The generated adapter expects your application to create and own the boxd machine. It does not decide machine identity, retention, or cleanup for you.

## Use it when

Choose boxd when a task requires real Linux command behavior in an isolated provider VM, particularly where a separate machine per workspace or agent instance is part of your application design.

Before reusing a machine across sessions or tenants, define identity, authorization, egress, secrets, and cleanup policies. Conversation persistence remains controlled separately by Flue session storage.

See [Sandboxes](/docs/guide/sandboxes/) for execution-boundary design and [Sandbox Adapter API](/docs/reference/sandbox-api/) for the adapter contract.
