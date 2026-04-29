# mask-chain-toy

A small, runnable demonstration of two ideas, in one repo:

1. **Tools-as-control-flow.** The engine special-cases nothing — even mask transitions are just tools that return `{ kind: 'terminate' }`.
2. **Self-modifying agents.** Because every transition is a tool, an agent can *write* new tools and masks at runtime and morph into them on the same turn. This is the meta-model — code that executes and modifies itself.

Companion to a design conversation about [autopoet/themis](https://github.com/ski/autopose). Self-contained — no Cloudflare, no real LLM, no external services. ~600 lines including comments.

## Run it

```bash
pnpm install

pnpm start              # scenario 'trip' — uses pre-existing masks (read this first)
pnpm start renovation   # scenario 'renovation' — agent invents a tool + mask mid-conversation
```

## Scenario 1: pre-existing chain

Receptionist captures the visitor's name + intent, then morphs into the planner. Planner looks up options, picks one, ends the chain.

```
━━━ mask-chain-toy (scenario: trip) ━━━
→ visitor: "hi"
  [receptionist] Welcome! What's your name?
→ visitor: "Alice"
  [receptionist] Nice to meet you, Alice. What can I help you with today?
    [engine] captured visitor_name=Alice
→ visitor: "I want to plan a trip somewhere quiet"
  [receptionist] Trip planning — got it. Let me hand you to our planner.
    [engine] morphed receptionist → planner (name=Alice, intent="…")
↳ cascade-fire into 'planner'
  [planner] Hi Alice — let me find some options for you.
  [planner] Iceland, 4 days. …
    [engine] session complete: …
```

## Scenario 2: self-modification

Visitor wants a kitchen-reno quote — receptionist has no mask for that. So in **one turn** the agent:

1. `define_tool` → registers `estimate_renovation` (a structured op-spec the engine compiles)
2. `define_mask` → registers `estimator` mask using that tool
3. `define_tool` → registers `morph_to_estimator` (also as ops)
4. `attach_tool_to_mask` → binds the new morph onto receptionist
5. fires `morph_to_estimator` — which only existed seconds ago

```
━━━ mask-chain-toy (scenario: renovation) ━━━
→ visitor: "I need a quote for a kitchen renovation"
  [receptionist] Renovations — let me set up an estimator for that.
    [engine] defined tool: estimate_renovation (3 ops)
    [engine] defined mask: estimator (2 tools)
    [engine] defined tool: morph_to_estimator (3 ops)
    [engine] attached tool 'morph_to_estimator' to mask 'receptionist'
    [engine] (agent-defined: morph_to_estimator) handed off to agent-built estimator
↳ cascade-fire into 'estimator'
  [estimator] Looking at a kitchen reno — let me run the numbers.
  [estimator] £18,500 ballpark, 6 weeks. …
━━━ session complete ━━━
registry now:   9 tools, 3 masks
agent-defined:
  + tool: estimate_renovation
  + tool: morph_to_estimator
  + mask: estimator
```

The agent grew its own toolkit and chain. Engine code didn't change. Restart the run, registry resets to 7 tools / 2 masks — you've drawn no extra surface area for the engine.

## The pattern

Each tool returns one of two things:

```ts
type ToolResult =
  | { kind: 'continue';  observation: unknown }
  | { kind: 'terminate'; observation?: unknown };
```

**`continue`** — engine feeds the observation back to the LLM and loops.
**`terminate`** — engine stops the current step.

A morph is just a tool that mutates state via `ctx.setNextMask(...)` and returns `{ kind: 'terminate' }`. The engine has zero special knowledge of "morphs" or "terminal tools."

### Compare against the alternative — engine special-cases the morph

```ts
// the OTHER way (NOT what this toy does)
if (action.tool === mask.terminalTool) {           // engine knows the magic name
  manifest.artifacts = { ...manifest.artifacts, ...action.input.artifacts };
  emit.morph(mask.nextMask, action.input);          // engine calls a special callback
  return;                                            // tool's execute is never run
}
const observation = await tool.execute(...);        // regular tools take this path
```

That works, but it splits "tool" semantics into two tracks — engine grows a `terminalTool` field, a `nextMask` field, a special-case branch. The morph-as-tool refactor collapses both tracks. One mental model, smaller engine, and the agent can write its own morph tools because morph tools are no longer privileged.

## How the agent "writes code"

The agent doesn't emit JavaScript. It emits a structured **op-spec** — a list of small primitives the runtime knows how to interpret.

```ts
type Op =
  | { op: 'capture'; field: string; from: 'input'; path: string }   // input.path → manifest.artifacts.field
  | { op: 'capture'; field: string; from: 'literal'; value: unknown }
  | { op: 'observe'; value: unknown }
  | { op: 'morph'; to: MaskName }
  | { op: 'complete' }
  | { op: 'log'; message: string }
  | { op: 'terminate' };
```

`compileToolSpec(spec)` walks the body and returns a real `Tool` whose `execute` interprets the ops at call time. Adding a new op = giving the agent a new building block. Removing an op = revoking a capability.

**No `eval`. No `new Function`. No string-of-JS to run.** Everything the agent emits is bound by the union above; an unknown op gets logged and skipped.

## Files

| File | What |
|---|---|
| [`src/types.ts`](src/types.ts) | Type surface (Tool, Mask, Op, ToolSpec, Registry). Read first. |
| [`src/registry.ts`](src/registry.ts) | Mutable catalog + `compileToolSpec` (Op[] → Tool). |
| [`src/tools.ts`](src/tools.ts) | Core tools (immutable). |
| [`src/meta-tools.ts`](src/meta-tools.ts) | `define_tool`, `define_mask`, `attach_tool_to_mask`. |
| [`src/masks.ts`](src/masks.ts) | Core masks. |
| [`src/engine.ts`](src/engine.ts) | The loop. Notice what _isn't_ here. |
| [`src/llm-mock.ts`](src/llm-mock.ts) | Scripted scenarios. |
| [`src/main.ts`](src/main.ts) | Wire it together. |

## What you get for free with this shape

- **Validation gates.** A morph tool can return `{ kind: 'continue', observation: { error: '…' } }` if the brief is incomplete — the model bounces, re-plans. No engine-level validator.
- **Composition.** A morph tool can call other tools internally before terminating. Engine doesn't care.
- **Uniform telemetry.** Every state transition is a tool call → emits the same `toolStart` / `toolEnd` events. Observability sees one shape instead of two.
- **Easier testing.** Each tool is a function with a context. No engine-level "morph happened" assertions needed.
- **Self-extending toolkits.** Agent invents new tools as data, registers them, uses them on the next turn. See scenario 2.
- **Self-extending mask chains.** Agent designs a new mask + morph + transitions into it. The chain becomes data the agent can edit.

## Real questions before scaling self-modification

The toy is deliberately small — these are the load-bearing decisions a real system has to settle:

### 1. Safety surface

A `define_tool` that accepts JS strings + uses `eval` is a remote-code-execution primitive. Two mitigations, in order of severity:

- **Structured ops (this toy's choice).** Agent emits data describing behaviour; runtime interprets. Adversarial input is bounded by the op union.
- **Sandboxed code.** If the structured DSL is too restrictive, run untrusted JS in `vm2`, `isolated-vm`, or WASM. Adds complexity but keeps native expressiveness.

Don't ship `eval(string)` even in research builds. The blast radius is the entire process.

### 2. Persistence + replay

When the agent invents a tool, where does it live? Three options with different durability:

- **In-memory only** (this toy). Lost on restart. Fine for sessions.
- **Written to disk / DB.** Survives restart. The agent's "skill library" persists across sessions.
- **Committed to git.** Tools become files the agent re-reads on next session. Self-improving codebase. Voyager (Minecraft agent) does this.

Each level adds ops complexity. Pick by need.

### 3. Validation

A tool the agent wrote may be subtly wrong. You want a **self-test loop** — when the agent registers a tool, run it against a tiny fixture before letting other masks rely on it. Voyager does this; their skill-validation step is half the value of the system.

The toy doesn't validate; in production you'd add a `test_tool` meta-tool the agent fires after `define_tool`, with a small fixture and an assertion.

### 4. Forgetting

A growing tool library with no pruning is a context-window disaster. Two mitigations:

- **Skill retrieval.** Don't load every registered tool into the LLM's context every turn. Embed each tool's `describe`, semantically retrieve the top-K relevant ones for the current step.
- **TTL / usage tracking.** Tools the agent hasn't fired in N steps get archived. Prevents drift accumulation.

### 5. Meta-stability

What stops the agent from rewriting `morph_to_planner` to a buggy version? The toy enforces an `isCoreTool` / `isCoreMask` check — the meta-tools refuse to overwrite anything flagged core during bootstrap. Agent-defined work is mutable; engine-shipped work isn't.

For a real system, also consider:

- **Versioning.** Every `define_tool` writes a new version; old versions are queryable for rollback.
- **Provenance.** Each agent-defined tool carries which mask defined it, which conversation, which turn. Audit trail.
- **Quorum.** A tool only enters the registry after N successful test runs.

### 6. Cascade depth

Self-modification can cause infinite cascades — agent defines a mask whose first turn defines another mask whose first turn defines another mask. The toy's outer loop has an implicit bound (each cascade only fires once `currentMask` changes from `previousMask` and progress runs out), but a real system wants an explicit max-cascade-depth counter.

## Not in scope (deliberately)

- Real LLM integration. The `Llm` interface is one method — drop in Anthropic / OpenAI behind it.
- Persistence. Manifest is in-memory.
- Streaming. Tools return resolved promises.
- Error recovery beyond "return an error observation."
- Parallelism — actions run sequentially.
- The harder safety + persistence + validation knobs above. Sketched, not built.

## Prior art / further reading

- **Voyager** ([2305.16291](https://arxiv.org/abs/2305.16291)) — Minecraft agent that writes JS skills, validates them, builds a library. The canonical reference for self-extending agents.
- **Generative Agents** ([2304.03442](https://arxiv.org/abs/2304.03442)) — believable agent simulacra that maintain memory + reflection loops.
- **MetaGPT, AutoGen, CrewAI** — various flavours of multi-agent orchestration with different stances on whether agents can modify the orchestration itself.

The piece this toy emphasises that those don't always: **state transitions as first-class tools**. That's the precondition for self-modification of the chain itself, not just of the toolkit.
