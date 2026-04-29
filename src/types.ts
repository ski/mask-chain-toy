/**
 * The whole type surface of the toy. ~50 lines. Read this first.
 */

export type MaskName = 'receptionist' | 'planner';

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
 * The result a tool returns. This is the load-bearing primitive of the pattern.
 *
 *   - 'continue'  → engine feeds the observation back to the LLM, loops.
 *   - 'terminate' → engine stops the current step; outer caller may swap masks.
 *
 * The TOOL decides whether the step ends, not the engine. Engine has no
 * special-case for "morph" — a morph tool is just a tool that returns
 * 'terminate' and (usually) flips manifest.currentMask via ctx.
 */
export type ToolResult =
  | { kind: 'continue'; observation: unknown }
  | { kind: 'terminate'; observation?: unknown };

/**
 * What a tool gets when invoked. The narrow set of engine-level levers
 * tools can pull. Add carefully — every method here is a power tools have.
 */
export interface ToolContext {
  /** Mutable ref. Tools can read accumulated state and write artifacts. */
  manifest: Manifest;
  /** Swap the active mask. Tools that morph call this; others don't touch it. */
  setNextMask(name: MaskName): void;
  /** Mark the chain finished. The terminal-of-terminals (no nextMask) calls this. */
  markComplete(): void;
  /** Engine-side log — separate from LLM patter. */
  log(message: string): void;
}

export interface Tool {
  name: string;
  /** What the LLM sees in its system prompt. The toy's mock LLM ignores it. */
  describe: string;
  /** What actually happens when the LLM fires this tool. */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface Mask {
  name: MaskName;
  systemPrompt: string;
  tools: Tool[];
}

/** Minimal LLM contract — given mask + history, return a turn. The toy
 *  uses a scripted mock; a real system would call Anthropic / OpenAI. */
export interface Llm {
  respond(mask: Mask, history: HistoryItem[]): Promise<LlmTurn>;
}

export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}
