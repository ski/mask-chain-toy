# mask-chain-toy

A 200-line, runnable demonstration of the **morph-as-tool** / **tools-as-control-flow** pattern. Read it to understand how a multi-mask agent loop hangs together when the engine treats every state transition as just-another-tool.

Companion to a design conversation about [autopoet/themis](https://github.com/ski/autopose). Self-contained — no Cloudflare, no real LLM, no external services.

## Run it

```bash
pnpm install
pnpm start
```

You'll see a conversation flow through two masks (receptionist → planner), morphing in the middle, cascading the new mask's first turn off the morph, and ending the chain when the planner locks in a plan.

## What you'll see

```
━━━ mask-chain-toy ━━━
starting mask: receptionist

→ visitor: "hi"
  [receptionist] Welcome! What's your name?

→ visitor: "Alice"
  [receptionist] Nice to meet you, Alice. What can I help you with today?
    [engine] captured visitor_name=Alice

→ visitor: "I want to plan a trip somewhere quiet"
  [receptionist] Trip planning — got it. Let me hand you to our planner.
    [engine] captured visitor_intent=plan a trip to somewhere quiet
    [engine] morphed receptionist → planner (name=Alice, intent="...")

↳ cascade-fire into 'planner'
  [planner] Hi Alice — let me find some options for you.
    [engine] looked up 3 options for "plan a trip to somewhere quiet"
  [planner] Iceland, 4 days. Quiet, dramatic, great for unwinding. ...
    [engine] session complete with plan: "Iceland 4-day: ..."

━━━ session complete ━━━
final mask:    planner
final status:  complete
final artifacts:
  visitor_name: "Alice"
  visitor_intent: "plan a trip to somewhere quiet"
  plan: "Iceland 4-day: ..."
```

## The pattern

Each tool returns one of two things:

```ts
type ToolResult =
  | { kind: 'continue';  observation: unknown }
  | { kind: 'terminate'; observation?: unknown };
```

**`continue`** — engine feeds the observation back to the LLM and loops.
**`terminate`** — engine stops the current step.

A morph is just a tool that:
1. Mutates the manifest (captures the brief).
2. Calls `ctx.setNextMask('planner')`.
3. Returns `{ kind: 'terminate' }`.

That's it. The engine has zero special knowledge of "morphs" or "terminal tools." It runs every action's `execute` the same way and exits when one of them says so.

## Why this matters

Compare against the alternative — engine special-cases the morph:

```ts
// the OTHER way (not what this toy does)
if (action.tool === mask.terminalTool) {           // engine knows the magic name
  manifest.artifacts = { ...manifest.artifacts, ...action.input.artifacts };
  emit.morph(mask.nextMask, action.input);          // engine calls a special callback
  return;                                            // tool's execute is never run
}
const observation = await tool.execute(...);        // regular tools take this path
```

That works, but it splits "tool" semantics into two tracks: **the morph tool** (engine handles) vs **regular tools** (tool handles). Two mental models for one concept. Engine grows a `terminalTool` field, a `nextMask` field, a special-case branch.

The morph-as-tool refactor collapses both tracks. One mental model, smaller engine, and you get **entry/exit hooks for free**: a tool can do *anything* in its `execute` — fetch data, validate the brief, emit telemetry, write episodes to memory, even fire other tools. Engine doesn't need to grow new hook surfaces.

### What you get for free

- **Validation gates.** A morph tool can return `{ kind: 'continue', observation: { error: '...' } }` if the brief is incomplete — model bounces back, re-plans. No engine-level validator.
- **Composition.** A `morph_to_planner` tool can call `save_episode` internally before terminating. Engine doesn't care.
- **Uniform telemetry.** Every state transition is a tool call → emits the same `toolStart` / `toolEnd` events. Observability sees one shape instead of two.
- **Easier testing.** Each tool is a function with a context. No engine-level "morph happened" assertions needed.

### What you give up

- **Tool surface power.** Tools mutate manifest state via `ctx`. Bad tool = bad day. Mitigated by keeping `ToolContext` narrow (this toy's surface is 4 methods).
- **Engine-level invariant clarity.** "Morphing" used to be one place in the engine; now it's spread across the morph tools. Read the tool to know what it does.

## Files

| File | What |
|---|---|
| [`src/types.ts`](src/types.ts) | The whole type surface (~50 lines). Read first. |
| [`src/engine.ts`](src/engine.ts) | The loop. Notice what _isn't_ here. |
| [`src/tools.ts`](src/tools.ts) | All tools, morphs included. They look the same. |
| [`src/masks.ts`](src/masks.ts) | Mask declarations. No `terminalTool` field. |
| [`src/llm-mock.ts`](src/llm-mock.ts) | Scripted "model" so the run is deterministic. |
| [`src/main.ts`](src/main.ts) | Wire it together. |

## Cascade-fire

When a tool morphs (`ctx.setNextMask('planner')`), the outer `runConversation` loop notices `manifest.currentMask` changed and runs the new mask's first turn with an `[INTERNAL]` user message — without consuming a real visitor message. That's "cascade-fire" — the new mask gets to speak immediately rather than waiting for the visitor to nudge it.

The toy bounds cascade depth implicitly: each cascade iteration loops back to the top of `while (manifest.currentMask !== previousMask)`. If a chain morphs again on entry, the outer loop catches it. A real system might cap this to one or two levels to prevent runaway swaps; the toy doesn't bother because the script is finite.

## Not in scope (deliberately)

- Real LLM integration (`Llm` interface is one method — drop in Anthropic / OpenAI behind it).
- Persistence (manifest is in-memory; real systems persist to a DO / DB).
- Streaming (tools return resolved promises; real systems stream patter chunks).
- Error recovery (tools throw → engine doesn't catch; real systems wrap and feed errors back as observations).
- Parallelism (actions run sequentially in this toy; real systems often parallelise non-terminal tools).
