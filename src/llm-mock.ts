/**
 * Scripted "LLM" — returns predetermined turns instead of calling a real
 * model. Keeps the toy deterministic so reading the run alongside the
 * code is reproducible. A real Llm implementation calls Anthropic /
 * OpenAI; the contract is the same.
 *
 * Each script entry is one turn. The script advances every time the
 * model is asked to respond. Per mask, so the receptionist's turns
 * advance independently of the planner's.
 */

import type { Action, Llm, LlmTurn, Mask, MaskName } from './types.js';

interface ScriptedTurn {
  patter: string;
  actions: Action[];
}

const SCRIPT: Record<MaskName, ScriptedTurn[]> = {
  receptionist: [
    // Turn 1: visitor said hi → ask for the name.
    {
      patter: 'Welcome! What\'s your name?',
      actions: [],
    },
    // Turn 2: visitor said "Alice" → capture, ask intent.
    {
      patter: 'Nice to meet you, Alice. What can I help you with today?',
      actions: [{ tool: 'ask_question', input: { field: 'visitor_name', value: 'Alice' } }],
    },
    // Turn 3: visitor said "plan a trip" → capture, morph to planner.
    {
      patter: 'Trip planning — got it. Let me hand you to our planner.',
      actions: [
        { tool: 'ask_question', input: { field: 'visitor_intent', value: 'plan a trip to somewhere quiet' } },
        { tool: 'morph_to_planner', input: { visitor_name: 'Alice', visitor_intent: 'plan a trip to somewhere quiet' } },
      ],
    },
  ],
  planner: [
    // Turn 1: cascade-fired with INTERNAL message → look up options.
    {
      patter: 'Hi Alice — let me find some options for you.',
      actions: [{ tool: 'lookup_options', input: { intent: 'plan a trip to somewhere quiet' } }],
    },
    // Turn 2: options came back → pick one, complete.
    {
      patter: 'Iceland, 4 days. Quiet, dramatic, great for unwinding. Booking notes coming your way.',
      actions: [
        {
          tool: 'complete_session',
          input: { plan: 'Iceland 4-day: Reykjavik base, day trips to Golden Circle + South Coast.' },
        },
      ],
    },
  ],
};

export function createMockLlm(): Llm {
  // Per-mask cursors — each mask's script advances independently.
  const cursors: Record<MaskName, number> = {
    receptionist: 0,
    planner: 0,
  };

  return {
    async respond(mask: Mask): Promise<LlmTurn> {
      const idx = cursors[mask.name];
      const script = SCRIPT[mask.name];
      if (idx >= script.length) {
        // Out of script — emit a no-op turn to avoid unbounded loops.
        return { patter: '(no scripted turn — engine should exit)', actions: [] };
      }
      cursors[mask.name] = idx + 1;
      // Tiny delay so the run looks like a stream rather than a flush.
      await new Promise((r) => setTimeout(r, 50));
      return script[idx];
    },
  };
}
