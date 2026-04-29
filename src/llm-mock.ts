/**
 * Scripted "LLM" — returns predetermined turns instead of calling a real
 * model. Two scenarios baked in:
 *
 *   - 'trip'        — visitor asks for trip planning; agent uses the
 *                     pre-existing planner mask (the v1 path).
 *   - 'renovation'  — visitor asks for a renovation quote; receptionist
 *                     has NO planner for this. The agent invents a tool
 *                     (`estimate_renovation`), defines a new mask
 *                     (`estimator`), attaches a morph tool to itself,
 *                     and morphs into the new mask. v2 self-modification.
 *
 * Pass the scenario name to createMockLlm(). The mock advances through
 * the matching script as the engine asks it for turns.
 */

import type { Action, Llm, LlmTurn, Mask } from './types.js';

interface ScriptedTurn {
  patter: string;
  actions: Action[];
}

type Scenario = 'trip' | 'renovation';

const SCRIPTS: Record<Scenario, Record<string, ScriptedTurn[]>> = {
  // ── Scenario 1: pre-existing path. Receptionist → Planner. ───────────
  trip: {
    receptionist: [
      { patter: 'Welcome! What\'s your name?', actions: [] },
      {
        patter: 'Nice to meet you, Alice. What can I help you with today?',
        actions: [{ tool: 'ask_question', input: { field: 'visitor_name', value: 'Alice' } }],
      },
      {
        patter: 'Trip planning — got it. Let me hand you to our planner.',
        actions: [
          { tool: 'ask_question', input: { field: 'visitor_intent', value: 'plan a trip to somewhere quiet' } },
          { tool: 'morph_to_planner', input: { visitor_name: 'Alice', visitor_intent: 'plan a trip to somewhere quiet' } },
        ],
      },
    ],
    planner: [
      {
        patter: 'Hi Alice — let me find some options for you.',
        actions: [{ tool: 'lookup_options', input: { intent: 'plan a trip to somewhere quiet' } }],
      },
      {
        patter: 'Iceland, 4 days. Quiet, dramatic, great for unwinding.',
        actions: [
          {
            tool: 'complete_session',
            input: { plan: 'Iceland 4-day: Reykjavik base, day trips to Golden Circle + South Coast.' },
          },
        ],
      },
    ],
  },

  // ── Scenario 2: self-modification. ───────────────────────────────────
  // Receptionist learns the visitor wants a renovation quote — no
  // existing mask handles that. So it: defines a tool, defines a mask
  // that uses it, defines a morph tool that targets the new mask,
  // attaches the morph tool to itself, then fires it.
  renovation: {
    receptionist: [
      { patter: 'Welcome! What\'s your name?', actions: [] },
      {
        patter: 'Hi Bob. What can I help you with?',
        actions: [{ tool: 'ask_question', input: { field: 'visitor_name', value: 'Bob' } }],
      },
      {
        // CRITICAL TURN — agent realises the request doesn't fit any known
        // mask, so it builds the missing pieces inline. Five tool calls
        // in one turn:
        //   1. define a domain tool (estimate_renovation)
        //   2. define a mask that uses it (estimator)
        //   3. define a morph tool targeting the new mask
        //   4. attach the morph tool to receptionist
        //   5. fire the morph tool
        // Each runs through the same uniform engine path. The morph
        // tool is just data the agent emitted seconds earlier.
        patter:
          'Renovations — let me set up an estimator for that.',
        actions: [
          {
            tool: 'ask_question',
            input: { field: 'visitor_intent', value: 'get a quote for renovating a kitchen' },
          },
          {
            tool: 'define_tool',
            input: {
              name: 'estimate_renovation',
              describe: 'Produce a rough renovation quote. Input: { scope }',
              body: [
                { op: 'capture', field: 'scope', from: 'input', path: 'scope' },
                { op: 'capture', field: 'estimate_gbp', from: 'literal', value: 18500 },
                {
                  op: 'observe',
                  value: {
                    quote_gbp: 18500,
                    timeline_weeks: 6,
                    notes: 'rough mid-range estimate; final quote after site visit',
                  },
                },
              ],
            },
          },
          {
            tool: 'define_mask',
            input: {
              name: 'estimator',
              systemPrompt:
                'You are a renovation estimator. Run estimate_renovation, then complete_session with the quote.',
              tools: ['estimate_renovation', 'complete_session'],
            },
          },
          {
            tool: 'define_tool',
            input: {
              name: 'morph_to_estimator',
              describe: 'Hand off to the agent-built estimator mask.',
              body: [
                { op: 'morph', to: 'estimator' },
                { op: 'log', message: 'handed off to agent-built estimator' },
                { op: 'terminate' },
              ],
            },
          },
          { tool: 'attach_tool_to_mask', input: { mask: 'receptionist', tool: 'morph_to_estimator' } },
          { tool: 'morph_to_estimator', input: {} },
        ],
      },
    ],
    estimator: [
      {
        patter: 'Looking at a kitchen reno — let me run the numbers.',
        actions: [{ tool: 'estimate_renovation', input: { scope: 'kitchen' } }],
      },
      {
        patter: '£18,500 ballpark, 6 weeks. We\'ll firm it up after a site visit.',
        actions: [
          {
            tool: 'complete_session',
            input: { quote_gbp: 18500, timeline_weeks: 6, scope: 'kitchen' },
          },
        ],
      },
    ],
  },
};

export function createMockLlm(scenario: Scenario): Llm {
  // Per-mask cursors so each mask's script advances independently.
  const cursors: Record<string, number> = {};

  return {
    async respond(mask: Mask): Promise<LlmTurn> {
      const script = SCRIPTS[scenario][mask.name];
      if (!script) {
        return {
          patter: `(no script for mask '${mask.name}' in scenario '${scenario}')`,
          actions: [],
        };
      }
      const idx = cursors[mask.name] ?? 0;
      if (idx >= script.length) {
        return { patter: '(out of script — engine should exit)', actions: [] };
      }
      cursors[mask.name] = idx + 1;
      await new Promise((r) => setTimeout(r, 50));
      return script[idx];
    },
  };
}
