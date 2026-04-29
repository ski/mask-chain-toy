/**
 * The whole type surface of the toy. ~80 lines. Read this first.
 */

/** Was a literal union in v1; becomes `string` in v2 because masks can
 *  be defined at runtime by the agent itself. */
export type MaskName = string;

export interface Manifest {
  /** When 'complete', the engine stops looping. Set by terminal tools. */
  status: 'active' | 'complete';
  /** Which mask is currently driving. Mutated by morph tools via ToolContext. */
  currentMask: MaskName;
  /** Captured facts (visitor name, intent, plan…) accumulated as the chain runs. */
  artifacts: Record<string, unknown>;
}

/** What the LLM emits per turn. The model decides what tool(s) to fire and what to say. */
export interface Action {
  tool: string;
  input: Record<string, unknown>;
}
export interface LlmTurn {
  patter: string;       // narration the visitor sees
  actions: Action[];    // tools to execute, in order
}

/**
 * The result a tool returns. Load-bearing primitive.
 *
 *   - 'continue'  → engine feeds the observation back to the LLM, loops.
 *   - 'terminate' → engine stops the current step; outer caller may swap masks.
 */
export type ToolResult =
  | { kind: 'continue'; observation: unknown }
  | { kind: 'terminate'; observation?: unknown };

/**
 * What a tool gets when invoked. The narrow set of engine-level levers.
 * v2 adds `registry` so meta-tools can mutate the tool/mask catalog.
 */
export interface ToolContext {
  manifest: Manifest;
  setNextMask(name: MaskName): void;
  markComplete(): void;
  log(message: string): void;
  /** v2 — meta-tools mutate this to add new tools / masks at runtime. */
  registry: Registry;
}

export interface Tool {
  name: string;
  describe: string;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface Mask {
  name: MaskName;
  systemPrompt: string;
  tools: Tool[];
}

/** Minimal LLM contract — given mask + history, return a turn. */
export interface Llm {
  respond(mask: Mask, history: HistoryItem[]): Promise<LlmTurn>;
}

export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

// ─── v2: self-modification primitives ────────────────────────────────────

/**
 * Structured tool body. The agent describes a tool's behaviour as data —
 * not a string of JS to `eval`. Each op is a primitive operation the
 * engine knows how to interpret. This is the "language" the agent writes
 * tools IN. Adding new ops = giving the agent new building blocks.
 *
 * Safety: zero arbitrary-code-execution surface. Whatever the agent
 * emits is bound by the union below; an op the runtime doesn't recognise
 * is logged and skipped.
 */
export type Op =
  | { op: 'capture'; field: string; from: 'input'; path: string }   // input.path → manifest.artifacts.field
  | { op: 'capture'; field: string; from: 'literal'; value: unknown }
  | { op: 'observe'; value: unknown }    // set the observation that gets returned
  | { op: 'morph'; to: MaskName }         // ctx.setNextMask
  | { op: 'complete' }                    // ctx.markComplete
  | { op: 'log'; message: string }
  | { op: 'terminate' }                   // wraps return as kind: 'terminate'
  // v3 — composition + verification primitives.
  // call_tool invokes another already-registered tool from inside an
  // agent-defined tool's body, capturing the observation into manifest
  // under `capture_to`. Lets the agent build new tools that COMPOSE
  // existing ones — the renovation tool, instead of returning a literal,
  // calls lookup_options to gather real data.
  | { op: 'call_tool'; tool: string; input?: Record<string, unknown>; capture_to: string };

export interface ToolSpec {
  name: string;
  describe: string;
  body: Op[];
}

export interface MaskSpec {
  name: MaskName;
  systemPrompt: string;
  tools: string[];   // names of already-registered tools
}

/**
 * Mutable runtime catalog. v1 used a const map; v2 makes it mutable
 * because that's what enables agents to extend the system.
 *
 * Keep this surface narrow. Every method here is a power agents have.
 */
export interface Registry {
  tools: Map<string, Tool>;
  masks: Map<MaskName, Mask>;
  /** True for tools/masks the engine considers core (immutable). The
   *  meta-tools refuse to overwrite these — the agent can't accidentally
   *  redefine `define_tool` to be a no-op. */
  core: Set<string>;
  /** v3 — set of tool names that have passed at least one fixture run
   *  via the `test_tool` meta-tool. The engine doesn't gate on this
   *  itself, but masks can opt in: a mask declared with
   *  `verifiedOnly: true` will refuse to dispatch to unverified
   *  agent-defined tools. Voyager uses environmental feedback for the
   *  same effect; we use a fixture the agent supplies. */
  verified: Set<string>;
}

/**
 * Fixture an agent supplies when it asks the runtime to verify a tool
 * it just defined. The `test_tool` meta-tool runs the named tool with
 * `input` and asserts the result matches the expectations below. On
 * pass, the tool is added to `registry.verified`. On fail, the agent
 * gets the error back as an observation and re-plans (typically by
 * editing the tool's body and re-defining).
 *
 * Intentionally narrow: a fixture can only assert the result kind, that
 * the observation contains certain keys, and that some artifact ended up
 * with an expected value. Anything more elaborate is its own tool.
 */
export interface ToolFixture {
  /** Name of the registered tool to test. */
  tool: string;
  /** Input passed to the tool's execute. */
  input: Record<string, unknown>;
  /** Expected result kind ('continue' or 'terminate'). */
  expects_kind?: 'continue' | 'terminate';
  /** Keys the observation object must contain (top-level only). */
  expects_observation_keys?: string[];
  /** Specific artifact assertions: { field: expected_value }. */
  expects_artifacts?: Record<string, unknown>;
}
