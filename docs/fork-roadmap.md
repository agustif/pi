# Fork Roadmap

## Why this fork exists

This fork is not just for small local tweaks. The serious line of work is using the fork as a place to pursue changes that upstream either cannot absorb quickly or should not absorb at all without stronger evidence.

The main fork-only thesis is:

1. Rebuild pi from first principles on an Effect-native runtime.
2. Carry product/runtime experiments that depend on private account behavior or hidden APIs.
3. Maintain a repeatable upstream-sync pipeline so the fork can diverge deeply without rotting.

## Source material

This roadmap consolidates work already done in local projects and notes, especially:

- `/Users/af/pi-effect/README.md`
- `/Users/af/pi-effect/TASKS.md`
- `/Users/af/pi-effect/docs/adr/0001-adopt-effect-as-foundational-runtime.md`
- `/Users/af/pi-effect/docs/rfcs/0001-effect-native-architecture.md`
- `/Users/af/pi-effect/docs/rfcs/0002-session-management-architecture.md`
- `/Users/af/pi-effect/docs/rfcs/0003-extension-system-design.md`
- `/Users/af/pi-effect/docs/architecture/overview.md`
- local fork work in `/Users/af/pi-mono`

## Epic 1: Effect-Native Rebuild

Goal: build a new generation of pi from first principles using Effect v4-style service/layer/stream patterns as the foundation rather than wrapping the existing architecture.

Why only a fork can do this:

- It changes the runtime model, dependency graph, and error model across the entire system.
- It is not an incremental extension; it is a competing architecture.
- It needs long-running experimentation without upstream compatibility pressure.

Sub-areas:

1. Core runtime and domain primitives
2. LanguageModel and provider abstraction
3. Session/tree/compaction architecture
4. Extension system redesign
5. CLI/TUI shell on top of the Effect runtime
6. Migration and interop strategy with current pi

## Epic 2: Fork-Only Codex Runtime Features

Goal: support account-scoped and hidden Codex capabilities that are useful locally but too speculative or private-API-dependent for upstream.

Examples already explored:

- account-scoped OpenAI Codex model hydration from the ChatGPT backend
- exposing hidden `codex-auto-review` locally
- model-specific fallback instructions for hidden review routing

Why only a fork can do this:

- depends on private/backend behavior instead of stable public contracts
- may expose hidden or experimental models
- may require behavior upstream would reasonably reject on maintenance grounds

## Epic 3: Upstream Sync and Patch Stack Automation

Goal: maintain deep fork changes as a replayable patch stack instead of letting `main` drift into one-off merge history.

Target shape:

- `upstream-main`: mirror of upstream default branch
- `fork-patches`: canonical fork-only commit stack
- `main`: generated integration branch produced by replaying `fork-patches` onto `upstream-main`

Why only a fork can do this:

- this is fork governance, not product behavior
- it exists to preserve local divergence while still ingesting upstream fast

## Epic 4: Fork Identity and Product Surface

Goal: treat the fork as a real product when needed, not just a renamed checkout.

Areas:

- binary name and update channel split
- config dir/env namespace isolation
- fork-specific docs and release process
- explicit boundary between upstream-safe and fork-only features

Why only a fork can do this:

- upstream should not own your release identity, state paths, or experimentation defaults

## Proposed issue stack

### Parent Epic

- `Fork-only roadmap: Effect-native rebuild and long-lived divergence strategy`

### Child Epics

- `Effect-native rebuild (pi-effect -> fork integration)`
- `Fork-only Codex runtime features`
- `Fork sync automation with upstream-main + fork-patches`
- `Fork identity, release channel, and config isolation`

### Effect-native rebuild child issues

- `Extract pi-effect architecture into a fork integration plan`
- `Prototype Effect-native core runtime package layout inside the fork`
- `Port LanguageModel/provider abstraction to Effect-first services`
- `Port session tree and compaction architecture from pi-effect RFCs`
- `Design Effect-native extension system bridge`
- `Define coexistence strategy between current pi and effect-native runtime`

### Codex child issues

- `Maintain account-scoped Codex model hydration`
- `Support hidden local review model routing with explicit guardrails`
- `Document private-API-dependent fork features and failure modes`

### Sync automation child issues

- `Add pi-upstream-update and pi-fork-update commands`
- `Automate replay of fork-patches onto upstream-main`
- `Generate patch artifacts and validation reports on sync runs`
- `Create failure triage workflow for sync conflicts`

### Identity child issues

- `Split fork update channel from upstream install/update behavior`
- `Plan fork-specific binary/config/env naming`
- `Document what belongs in fork core vs extension space`
