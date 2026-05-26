# E2E Claude Mocking

This document is the source of truth for how the mocked `claude` CLI must behave in the Playwright E2E suite.

It is normative documentation. New E2E tests should follow this model.

## Purpose

The E2E suite must exercise Pixel Agents through a Claude-like process boundary.

That means:

- every E2E scenario must spawn `claude`
- tests must not directly emit hook payloads
- tests must not directly create or mutate JSONL transcript files
- the mocked `claude` must behave like the real Claude CLI for the parts that Pixel Agents depends on

## Hard Rules

These rules are non-negotiable for the E2E suite:

- E2E tests must never call `sendHookEvent` directly.
- E2E tests must never append JSON objects directly into transcript files.
- E2E tests must never create Claude transcript files as the primary driver of behavior.
- The mocked `claude` is responsible for creating transcript files itself.
- The mocked `claude` is responsible for executing the Pixel Agents hook script(s) under `~/.pixel-agents/hooks`, just like the real Claude CLI.
- Assertions stay in Playwright. The mock does not decide pass/fail.

## Real Claude vs Mock Claude

For the E2E contract, the mock should mirror the real CLI at the boundary that Pixel Agents observes.

Shared responsibilities:

- spawn as a process
- choose a session shape appropriate to the test
- create its own JSONL transcript files
- append new JSON objects to those transcripts over time
- execute the installed hook script(s) under `~/.pixel-agents/hooks`
- emit hook payloads through the same hook integration path the real CLI uses

Important transcript rule:

- JSONL files are append-only streams
- once a transcript file exists, existing lines are not modified in place
- new JSON objects may appear later in the stream

## Arrange, Act, Assert

The E2E suite uses a strict Arrange / Act / Assert split.

### Arrange

Arrange is owned by the Playwright test and the test harness.

Arrange is allowed to:

- define the scenario using a Builder Pattern
- configure isolated `HOME`, workspace, and environment
- start VS Code
- optionally prepare team config under `~/.claude/teams/<teamName>/config.json`
- define timed JSONL writes
- define timed hook posts
- define child mock processes for teammates
- define tmux pane/session joins when tmux is part of the scenario

Arrange is not allowed to:

- post hooks itself
- write transcript records itself
- bypass the mock and drive Pixel Agents directly

### Act

Act is owned by the mocked `claude`.

There is exactly one Act: the mock plays the scenario defined in Arrange.

Act includes:

- spawning the mock process
- creating the transcript file(s)
- appending transcript records over time
- executing the hook script(s)
- emitting hook payloads over time
- spawning child mock processes for teammates when the scenario requires them
- joining tmux panes/sessions when the scenario requires them

During Act, the test should not intervene in Claude behavior.

### Assert

Assert is owned by Playwright.

Assert includes observing and checking:

- webview UI state changes
- office overlays and character lifecycle
- terminal presence where relevant
- transcript file state for verification only
- other user-visible consequences of Claude activity

Assert does not include:

- asking the mock whether the scenario passed
- putting pass/fail logic inside the mock

## Scenario Definition Model

Scenarios are arranged through a Builder Pattern.

The builder must be low-level.

That means the builder should describe primitives like:

- process spawn
- session identity
- transcript file creation
- transcript record append at time `t`
- hook emission at time `t`
- child mock process spawn at time `t`
- tmux join / pane creation at time `t`
- process exit at time `t`

The builder output format is an implementation detail.
The contract is the behavioral model, not whether the builder serializes to JSON, TS objects, or another internal representation.

Illustrative shape only:

```ts
const scenario = claudeScenario()
  .session('lead')
  .transcript('lead.jsonl')
  .at(0, (lead) => lead.appendJsonl({ type: 'system', subtype: 'init' }))
  .at(100, (lead) => lead.emitHook('SessionStart', { source: 'startup' }))
  .at(300, (lead) => lead.appendJsonl({ type: 'assistant', message: { content: [] } }))
  .at(500, (lead) => lead.spawnChild('teammate'))
  .at(800, (lead) => lead.exit());
```

The exact API is not fixed by this document. The low-level responsibility split is.

## Session Spawning

How sessions are spawned depends on the test.

Examples:

- internal session: spawned through the VS Code `+ Agent` flow
- external session: spawned outside the VS Code terminal but under the arranged environment
- teammate session: spawned as a child mock Claude process
- tmux teammate session: the harness creates the tmux container and the mock joins it

The spawning mechanism is scenario-specific.
The rule is that Claude still owns Claude behavior once the process starts.

## Hooks ON and Hooks OFF

The mock must support both modes from the same scenario model.

Hooks ON:

- the mock executes the hook script(s)
- hook payloads are emitted on schedule
- transcripts are still written normally

Hooks OFF:

- the mock still writes transcripts normally
- hook emission is suppressed or disabled according to the scenario
- Pixel Agents should discover behavior through its fallback mechanisms

## Capabilities The Mock Must Grow To Support

The mock is expected to grow as the E2E suite grows.

Required capabilities:

- internal basic sessions
- external sessions
- append-only transcript creation
- timed transcript record emission
- timed hook emission through `~/.pixel-agents/hooks`
- lifecycle events such as `/clear`, `--resume`, and exit
- within-turn subagents
- teammate child processes
- tmux join behavior for teammate processes
- Hooks ON and Hooks OFF execution from the same arranged scenario model

## Current Capability Snapshot

As of today, the current mock is still much smaller than the target model.

What it can do today:

- act as a fake `claude` executable on `PATH`
- parse `--session-id`
- log its invocation under `$HOME/.claude-mock/invocations.log`
- create the expected lead transcript file under `~/.claude/projects/...`
- append a minimal init record
- stay alive long enough for terminal-based tests to observe it

## Current Gaps

The current mock is missing the behaviors required by this document.

Missing or incomplete today:

- no builder-pattern scenario engine
- no timed action playback model
- no hook-script execution parity with the real CLI
- no hook emission owned by the mock
- no external-session spawning through the mock as the authoritative driver
- no child mock process orchestration for teammates
- no tmux join behavior
- no append-only transcript evolution beyond the initial init line
- no single mock-owned Arrange-to-Act handoff for existing tests

Because of these gaps, some current tests still rely on direct hook or transcript fixtures.
Those tests should be migrated over time to this document's model.

## Builder Pattern Responsibilities

The builder is part of Arrange, not Act.

It should define:

- which Claude processes exist
- when each process starts
- which session ids and transcript paths they own
- which transcript records appear and when
- which hook payloads appear and when
- which child processes exist and when
- which tmux targets are joined and when
- when each process exits

The builder should not:

- execute hooks itself
- write transcript lines itself
- replace the mock with a direct helper call

## Team Scenarios

For team scenarios:

- the teammate must also be a spawned mock Claude process
- team config may still be prepared by the harness in Arrange
- the mock process is responsible for its own transcript stream
- teammate discovery should emerge from the real file and hook behavior, not from direct test mutation

## Tmux Scenarios

For tmux scenarios:

- the test harness creates the tmux container
- the mock Claude process joins that tmux container
- teammate processes may run in separate tmux panes
- the E2E suite should verify the user-visible office behavior
- tmux process details are supporting evidence, not the primary assertion target

## Assertion Philosophy

The mock should behave like Claude, not like a test oracle.

Therefore:

- the mock emits behavior
- Playwright observes outcomes
- pass/fail stays in the test

The test may inspect transcripts and mock logs during Assert, but only as evidence.
Those artifacts do not replace UI and lifecycle assertions.

## Migration Direction

When new E2E tests are added or old ones are rewritten, move them toward this model:

1. arrange the scenario with the builder
2. spawn mock Claude process(es)
3. let the mock perform the full Act
4. assert only from Playwright-visible outcomes and supporting artifacts

Direct `sendHookEvent` calls and direct transcript mutations should be treated as temporary legacy test techniques and removed over time.
