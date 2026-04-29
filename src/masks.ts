/**
 * The mask declarations. Compare these to the autopoet `Mask` type — note
 * that there's NO `terminalTool: 'morph_to_planner'` field here. The mask
 * just lists its tools. The engine has no idea which one is "the morph"
 * because that distinction doesn't exist in this architecture.
 *
 * If you want a different mask transition, add a new tool to the tools
 * array — that's it. No engine changes, no terminal-tool registry update.
 */

import type { Mask, MaskName } from './types.js';
import {
  ASK_QUESTION,
  COMPLETE_SESSION,
  LOOKUP_OPTIONS,
  MORPH_TO_PLANNER,
} from './tools.js';

export const RECEPTIONIST_MASK: Mask = {
  name: 'receptionist',
  systemPrompt:
    'You are a receptionist. Greet the visitor, capture their name and intent ' +
    'using ask_question, then morph_to_planner with both fields filled in.',
  tools: [ASK_QUESTION, MORPH_TO_PLANNER],
};

export const PLANNER_MASK: Mask = {
  name: 'planner',
  systemPrompt:
    'You are a planner. The receptionist captured the visitor\'s name + intent. ' +
    'Look up options matching the intent, pick one, and complete_session with the plan.',
  tools: [LOOKUP_OPTIONS, COMPLETE_SESSION],
};

export const MASK_REGISTRY: Record<MaskName, Mask> = {
  receptionist: RECEPTIONIST_MASK,
  planner: PLANNER_MASK,
};
