/**
 * Core tools (immutable — agent-defined tools cannot overwrite these).
 * Notice the morph tool (`morph_to_planner`) looks like every other tool.
 * It IS just a tool. Engine has no special knowledge of "morphing."
 */

import type { Tool } from './types.js';

export const ASK_QUESTION: Tool = {
  name: 'ask_question',
  describe:
    'Capture an answer the visitor just gave. Input: { field: string, value: string }',
  execute: async (input, ctx) => {
    const field = String(input.field);
    const value = String(input.value);
    ctx.manifest.artifacts[field] = value;
    ctx.log(`captured ${field}=${value}`);
    return {
      kind: 'continue',
      observation: { ok: true, captured: { [field]: value } },
    };
  },
};

/**
 * Receptionist → Planner morph. A regular tool that returns 'terminate'
 * after mutating the mask via ctx.setNextMask. No engine special-case.
 *
 * Validation lives here: missing fields return { kind: 'continue', error }
 * and the LLM bounces back to capture them properly.
 */
export const MORPH_TO_PLANNER: Tool = {
  name: 'morph_to_planner',
  describe:
    'Hand off to the planner mask. Input: { visitor_name: string, visitor_intent: string }. ' +
    'Both required.',
  execute: async (input, ctx) => {
    const name = typeof input.visitor_name === 'string' ? input.visitor_name : '';
    const intent =
      typeof input.visitor_intent === 'string' ? input.visitor_intent : '';
    if (!name || !intent) {
      return {
        kind: 'continue',
        observation: { error: 'visitor_name + visitor_intent required' },
      };
    }
    ctx.manifest.artifacts.visitor_name = name;
    ctx.manifest.artifacts.visitor_intent = intent;
    ctx.setNextMask('planner');
    ctx.log(`morphed receptionist → planner (name=${name}, intent="${intent}")`);
    return { kind: 'terminate', observation: { ok: true } };
  },
};

export const LOOKUP_OPTIONS: Tool = {
  name: 'lookup_options',
  describe: 'Look up trip options for the visitor intent. Input: { intent: string }',
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
 * Terminal-of-terminals. Marks the manifest complete; outer loop exits.
 * Available to any mask that wants to end the chain — including
 * agent-defined masks that pull it in via define_mask({ tools: [..., 'complete_session'] }).
 */
export const COMPLETE_SESSION: Tool = {
  name: 'complete_session',
  describe: 'Lock in the result and end the session. Input: { plan: string } (or any payload).',
  execute: async (input, ctx) => {
    ctx.manifest.artifacts.result = input;
    ctx.markComplete();
    ctx.log(`session complete: ${JSON.stringify(input).slice(0, 80)}`);
    return { kind: 'terminate', observation: { ok: true } };
  },
};

export const CORE_TOOLS: Tool[] = [
  ASK_QUESTION,
  MORPH_TO_PLANNER,
  LOOKUP_OPTIONS,
  COMPLETE_SESSION,
];
