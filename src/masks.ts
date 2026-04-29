/**
 * Core mask declarations. Compare to the autopoet `Mask` type — note
 * that there's no `terminalTool` field. The engine has zero special
 * knowledge of which tools end a step.
 *
 * v2: receptionist gains access to the meta-tools (define_tool,
 * define_mask, attach_tool_to_mask) so the agent can extend itself
 * mid-conversation. Those tools do real things — see meta-tools.ts.
 */

import type { Mask } from './types.js';
import {
  ASK_QUESTION,
  COMPLETE_SESSION,
  LOOKUP_OPTIONS,
  MORPH_TO_PLANNER,
} from './tools.js';
import { ATTACH_TOOL_TO_MASK, DEFINE_MASK, DEFINE_TOOL, TEST_TOOL } from './meta-tools.js';

export const RECEPTIONIST_MASK: Mask = {
  name: 'receptionist',
  systemPrompt:
    'You are a receptionist. Greet the visitor, capture their name and intent ' +
    'using ask_question. If their intent fits a known handler (planner: trip ' +
    'planning), morph there. Otherwise grow a handler: define_tool to write a ' +
    'tool that COMPOSES existing tools (use the call_tool op so the new tool ' +
    'actually does work, not just returns a literal); test_tool with a small ' +
    'fixture before relying on it; define_mask using only verified tools; ' +
    'define + attach a morph tool; morph into the new mask.',
  tools: [
    ASK_QUESTION,
    MORPH_TO_PLANNER,
    DEFINE_TOOL,
    TEST_TOOL,
    DEFINE_MASK,
    ATTACH_TOOL_TO_MASK,
  ],
};

export const PLANNER_MASK: Mask = {
  name: 'planner',
  systemPrompt:
    'You are a planner. Look up trip options matching the visitor intent, ' +
    'pick one, and complete_session with the plan.',
  tools: [LOOKUP_OPTIONS, COMPLETE_SESSION],
};

/** Both masks export COMPLETE_SESSION-equivalents indirectly: an
 *  agent-defined mask can declare COMPLETE_SESSION in its tool list
 *  (it's a registered tool name) and end the chain itself. */
export const CORE_MASKS: Mask[] = [RECEPTIONIST_MASK, PLANNER_MASK];
