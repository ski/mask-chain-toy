# mask-chain-toy

A small, runnable demonstration of three ideas, in one repo:

1. **Tools-as-control-flow.** The engine special-cases nothing — even mask transitions are just tools that return `{ kind: 'terminate' }`.
2. **Self-modifying agents.** Because every transition is a tool, an agent can *write* new tools and masks at runtime and morph into them on the same turn.
3. **Composition + verification.** An invented tool can compose existing tools (so the new behaviour does real work, not just returns a literal), and the agent can run a fixture-based test against its own creation before any other mask depends on it.

Companion to a design conversation about [autopoet/themis](https://github.com/ski/autopose). Self-contained — no Cloudflare, no real LLM, no external services. ~700 lines including comments.

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

## Scenario 2: self-modification with composition + verification

Visitor wants a kitchen-reno quote — receptionist has no mask for that. The agent:

1. `define_tool` → registers `estimate_renovation`. Its body uses the **`call_tool`** op to delegate into the existing `lookup_options` tool — so the new tool actually does work by composing what's already there, not by returning a literal.
2. `test_tool` → runs the new tool against a small fixture (input + expected observation keys + expected artifacts). On pass, the tool gets added to `registry.verified`. On fail, the agent sees the errors and re-plans. **This is the verification half** — Voyager's environmental-feedback step, with an agent-supplied fixture instead of a Minecraft world.
3. `define_mask` → registers `estimator` using the (now-verified) tool.
4. `define_tool` + `attach_tool_to_mask` → builds and attaches `morph_to_estimator`.
5. fires `morph_to_estimator` — which only existed seconds ago.

```
━━━ mask-chain-toy (scenario: renovation) ━━━
→ visitor: "I need a quote for a kitchen renovation"
  [receptionist] Renovations — let me set something up for that.
    [engine] defined tool: estimate_renovation (3 ops)
    [engine] (test:estimate_renovation) looked up 3 options for "kitchen renovation"
    [engine] test_tool estimate_renovation: PASS — verified
  [receptionist] Verified the estimator. Routing you to it now.
    [engine] defined mask: estimator (2 tools)
    [engine] defined tool: morph_to_estimator (3 ops)
    [engine] attached tool 'morph_to_estimator' to mask 'receptionist'
    [engine] (agent-defined: morph_to_estimator) handed off to agent-built estimator
↳ cascade-fire into 'estimator'
  [estimator] Composing your kitchen-reno quote from current option data.
    [engine] looked up 3 options for "kitchen renovation"
  [estimator] Three options came back from lookup; quote built around them. …
━━━ session complete ━━━
registry now:   10 tools, 3 masks
agent-defined:
  + tool: estimate_renovation
  + tool: morph_to_estimator
  + mask: estimator
```

Note `option_data: {"options":["Option A","Option B","Option C"]}` in the final manifest — that came from `lookup_options` running inside `estimate_renovation`'s body via the `call_tool` op. The invented tool produced real output by delegating to a tool the agent didn't write. Restart the run; the registry resets to 8 tools / 2 masks. Engine code didn't change.

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
  | { op: 'terminate' }
  | { op: 'call_tool'; tool: string; input?: object; capture_to: string };
```

`compileToolSpec(spec)` walks the body and returns a real `Tool` whose `execute` interprets the ops at call time. Adding a new op = giving the agent a new building block. Removing an op = revoking a capability.

The `call_tool` op is what makes invented tools do real work. Without it, an agent's new tool can only capture inputs and return literals — structurally interesting but operationally trivial. With it, the new tool delegates into the registry, composing existing capabilities in fresh ways.

**No `eval`. No `new Function`. No string-of-JS to run.** Everything the agent emits is bound by the union above; an unknown op gets logged and skipped. **But** — see the safety section below — this bounds the *vocabulary*, not the *reachability graph*. A `call_tool` op chained into a tool that touches sensitive state is still chained into that state.

## Files

| File | What |
|---|---|
| [`src/types.ts`](src/types.ts) | Type surface (Tool, Mask, Op, ToolSpec, Registry, ToolFixture). Read first. |
| [`src/registry.ts`](src/registry.ts) | Mutable catalog + `compileToolSpec` (Op[] → Tool, including `call_tool`). |
| [`src/tools.ts`](src/tools.ts) | Core tools (immutable). |
| [`src/meta-tools.ts`](src/meta-tools.ts) | `define_tool`, `test_tool`, `define_mask`, `attach_tool_to_mask`. |
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

**The honest caveat.** The op vocabulary being small doesn't mean the *reachability graph* is small. A `call_tool` op chained into `send_email` is still calling `send_email`. A `capture` op writing into an artifact field that a downstream trusted tool reads is still mutating that field. The DSL bounds *what kinds of things* an invented tool can do; it doesn't bound *which existing tools* it can compose with, or *which state fields* it can touch. If your tool registry contains anything you wouldn't hand the agent a literal pointer to, you need either a "safe-to-compose" tag on each tool the agent can `call_tool` into, or a sandbox manifest that scopes `capture` to non-sensitive fields. Neither is in this toy.

### 2. Persistence + replay

When the agent invents a tool, where does it live? Three options with different durability:

- **In-memory only** (this toy). Lost on restart. Fine for sessions.
- **Written to disk / DB.** Survives restart. The agent's "skill library" persists across sessions.
- **Committed to git.** Tools become files the agent re-reads on next session. Self-improving codebase. Voyager (Minecraft agent) does this.

Each level adds ops complexity. Pick by need.

### 3. Validation

This is the half Voyager spends most of its complexity budget on, and the toy now demonstrates a minimal version: the `test_tool` meta-tool runs a fixture against a freshly-defined tool, asserts the result kind / observation keys / artifact effects, and adds the tool to `registry.verified` on pass. Other masks can declare `verifiedOnly: true` to refuse anything not in that set.

What the toy's verification does NOT cover (deliberately):

- **Reachability.** A verified tool can still `call_tool` into something dangerous; the fixture only exercises one path.
- **Side effects on real systems.** A tool that writes to a real API will write during the test run too. Sandbox if you mean it.
- **Adversarial fixtures.** The agent that wrote the tool also wrote the fixture. If it can pass its own test, it passes. The next step is a separate "auditor" agent writing fixtures for a "builder" agent's tools — the actual verification loop you'd want in production.

Even the minimal shape catches the commonest failure mode: "the tool I wrote doesn't actually do what I claimed in its describe string."

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
