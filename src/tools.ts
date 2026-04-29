/**
 * Every tool the toy uses. Notice the morph tools (`morph_to_planner`,
 * `complete_session`) look exactly like regular tools — they just return
 * { kind: 'terminate' } and (optionally) call ctx.setNextMask / ctx.markComplete.
 *
 * In a "engine special-cases the morph tool" world, the receptionist's
 * exit logic would live in the engine itself. Here it lives in the tool.
 * Add a new mask transition? Add a new tool. Engine doesn't change.
 */

import type { Tool } from './types.js';

/**
 * Receptionist's working tool — capture a piece of visitor data and continue.
 * Returns 'continue' so the LLM gets the observation and decides next step.
 */
export const ASK_QUESTION: Tool = {
  name: 'ask_question',
  describe: 'Capture an answer the visitor just gave. Input: { field: string, value: string }',
  execute: async (input, ctx) => {
    const field = String(input.field);
    const value = String(input.value);
    ctx.manifest.artifacts[field] = value;
    ctx.log(`captured ${field}=${value}`);
    return { kind: 'continue', observation: { ok: true, captured: { [field]: value } } };
  },
};

/**
 * Receptionist → Planner morph. Looks like a tool, IS a tool.
 *
 * - Merges the receptionist's brief into manifest.artifacts.
 * - Calls ctx.setNextMask('planner') — that's the "swap" you'd see
 *   open-coded in an engine-special-cased version.
 * - Returns 'terminate' so the engine stops looping in receptionist
 *   and the outer runConversation cascades into planner.
 *
 * Validation lives here too: if the brief is incomplete, return
 * { kind: 'continue', observation: { error: ... } } and the LLM bounces.
 * No engine-level validation gate needed.
 */
export const MORPH_TO_PLANNER: Tool = {
  name: 'morph_to_planner',
  describe:
    'Hand off to the planner. Input: { visitor_name: string, visitor_intent: string }. ' +
    'Both required — you cannot morph without them.',
  execute: async (input, ctx) => {
    const name = typeof input.visitor_name === 'string' ? input.visitor_name : '';
    const intent = typeof input.visitor_intent === 'string' ? input.visitor_intent : '';

    // Validation. If the LLM tried to morph without a complete brief,
    // bounce back with an error observation — model re-plans.
    if (!name || !intent) {
      return {
        kind: 'continue',
        observation: {
          error: 'Missing visitor_name or visitor_intent. Capture both before morphing.',
        },
      };
    }

    ctx.manifest.artifacts.visitor_name = name;
    ctx.manifest.artifacts.visitor_intent = intent;
    ctx.setNextMask('planner');
    ctx.log(`morphed receptionist → planner (name=${name}, intent="${intent}")`);
    return { kind: 'terminate', observation: { ok: true } };
  },
};

/**
 * Planner's working tool — pretend to look up some options. In a real
 * system this might hit a search API. Here it returns canned options
 * keyed off the visitor intent so the run is deterministic.
 */
export const LOOKUP_OPTIONS: Tool = {
  name: 'lookup_options',
  describe: 'Look up options for the visitor intent. Input: { intent: string }',
  execute: async (input, ctx) => {
    const intent = String(input.intent ?? '');
    const options =
      intent.toLowerCase().includes('trip') || intent.toLowerCase().includes('travel')
        ? ['Lisbon weekend', 'Iceland 4-day', 'Tokyo 7-day']
        : ['Option A', 'Option B', 'Option C'];
    ctx.log(`looked up ${options.length} options for "${intent}"`);
    return { kind: 'continue', observation: { options } };
  },
};

/**
 * Planner's terminal tool. End of chain — no nextMask, just markComplete.
 *
 * This is where the chain ENDS, not where it morphs. The engine cares
 * about 'terminate'; ctx.markComplete() flags the manifest so the outer
 * runConversation loop exits.
 */
export const COMPLETE_SESSION: Tool = {
  name: 'complete_session',
  describe: 'Lock in the plan and end the session. Input: { plan: string }',
  execute: async (input, ctx) => {
    const plan = String(input.plan ?? '');
    ctx.manifest.artifacts.plan = plan;
    ctx.markComplete();
    ctx.log(`session complete with plan: "${plan}"`);
    return { kind: 'terminate', observation: { ok: true, plan } };
  },
};
