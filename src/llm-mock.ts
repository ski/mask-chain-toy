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

  // ── Scenario 2: self-modification with composition + verification. ──
  // Receptionist learns the visitor wants a renovation quote. No existing
  // mask handles that. The agent:
  //   1. Defines `estimate_renovation` whose body COMPOSES the existing
  //      lookup_options tool via `call_tool` — pulls real data, captures
  //      it, observes a structured quote built from the lookup result.
  //   2. Calls `test_tool` against a fixture BEFORE letting any other
  //      mask depend on it. If the fixture fails the agent re-plans.
  //   3. Defines an `estimator` mask using the (now-verified) tool.
  //   4. Defines a morph tool, attaches it, fires it.
  //
  // The composition step makes the new tool actually do work — not just
  // return a literal. The verification step catches the case where the
  // tool's behaviour drifts from its describe string. Together they
  // close the gap between "the agent grew a thing" and "the thing the
  // agent grew is trustworthy."
  renovation: {
    receptionist: [
      { patter: 'Welcome! What\'s your name?', actions: [] },
      {
        patter: 'Hi Bob. What can I help you with?',
        actions: [{ tool: 'ask_question', input: { field: 'visitor_name', value: 'Bob' } }],
      },
      {
        // TURN 1 of self-modification: capture intent, define the
        // composing tool, verify it, define the mask. We split this
        // across two turns (this one + the next) so the verification
        // observation can be seen and reacted to before we commit to
        // morphing — that's the realistic shape, not "do everything
        // optimistically in one turn."
        patter:
          'Renovations — let me set something up for that.',
        actions: [
          {
            tool: 'ask_question',
            input: { field: 'visitor_intent', value: 'get a quote for renovating a kitchen' },
          },
          {
            // The invented tool COMPOSES lookup_options. The body says:
            //   - capture the scope from input
            //   - call lookup_options with the scope (captures result
            //     into manifest.artifacts.option_data)
            //   - observe a structured quote referencing that data
            // The estimate isn't a literal anymore — it's "whatever
            // lookup_options came back with, packaged as a quote shape."
            tool: 'define_tool',
            input: {
              name: 'estimate_renovation',
              describe:
                'Produce a renovation quote by composing lookup_options. Input: { scope }',
              body: [
                { op: 'capture', field: 'scope', from: 'input', path: 'scope' },
                {
                  op: 'call_tool',
                  tool: 'lookup_options',
                  input: { intent: 'kitchen renovation' },
                  capture_to: 'option_data',
                },
                {
                  op: 'observe',
                  value: {
                    composed_from: 'lookup_options',
                    quote_shape: 'options-derived',
                    notes:
                      'Estimate built by composing the existing lookup_options tool — not a literal.',
                  },
                },
              ],
            },
          },
          {
            // Verification fixture. If estimate_renovation doesn't
            // produce an observation containing 'composed_from', or
            // doesn't capture 'scope' into the manifest, the test fails
            // and the agent re-plans. The fixture is written by the
            // same agent that wrote the tool, so this catches honest
            // mistakes (didn't capture what I claimed, didn't observe
            // what I claimed) — it doesn't catch adversarial intent.
            // For that you'd want a separate "auditor" agent writing
            // fixtures for the "builder" agent's tools.
            tool: 'test_tool',
            input: {
              tool: 'estimate_renovation',
              input: { scope: 'kitchen' },
              expects_kind: 'continue',
              expects_observation_keys: ['composed_from', 'quote_shape'],
              expects_artifacts: { scope: 'kitchen' },
            },
          },
        ],
      },
      {
        // TURN 2: verification observation came back (PASS). Now build
        // the mask using the now-verified tool, define the morph,
        // attach, fire.
        patter:
          'Verified the estimator. Routing you to it now.',
        actions: [
          {
            tool: 'define_mask',
            input: {
              name: 'estimator',
              systemPrompt:
                'You are a renovation estimator. Use estimate_renovation to compose a quote, then complete_session.',
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
        patter: 'Composing your kitchen-reno quote from current option data.',
        actions: [{ tool: 'estimate_renovation', input: { scope: 'kitchen' } }],
      },
      {
        patter:
          'Three options came back from lookup; quote built around them. Sending the structured result.',
        actions: [
          {
            tool: 'complete_session',
            input: { scope: 'kitchen', method: 'composed via lookup_options' },
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
