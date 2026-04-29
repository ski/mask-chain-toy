/**
 * The engine. This is the whole point of the toy — read it and notice what
 * ISN'T here. There's no `if (action.tool === mask.terminalTool)` magic.
 * No `emit.morph` callback. The engine treats every tool the same way:
 * call execute, feed the observation back, stop when a tool says so.
 *
 * The morph behaviour lives inside the tool (see `tools.ts:morphToPlanner`).
 * That's the "tools-as-control-flow" pattern: the engine knows about steps
 * and observations, the TOOLS know about masks and morphs.
 */

import type { HistoryItem, Llm, Manifest, Mask, ToolContext } from './types.js';
import { MASK_REGISTRY } from './masks.js';

const MAX_ITERATIONS_PER_STEP = 10;

/**
 * Run one "step" — a single user message turn that may bounce through
 * several LLM calls + tool fires before yielding back to the visitor or
 * morphing into a new mask.
 *
 * Returns when:
 *  - a tool returns { kind: 'terminate' }
 *  - the LLM emits zero actions (mask is waiting on the visitor)
 *  - max iterations safety cap hits
 */
export async function runStep(
  userMessage: string,
  mask: Mask,
  manifest: Manifest,
  llm: Llm,
): Promise<void> {
  const history: HistoryItem[] = [{ role: 'user', content: userMessage }];

  for (let iter = 0; iter < MAX_ITERATIONS_PER_STEP; iter++) {
    const turn = await llm.respond(mask, history);

    // Show the visitor-facing narration.
    console.log(`  [${mask.name}] ${turn.patter}`);
    history.push({ role: 'assistant', content: JSON.stringify(turn) });

    // No tools this turn — mask is waiting on the visitor's reply.
    if (turn.actions.length === 0) return;

    let terminated = false;
    for (const action of turn.actions) {
      const tool = mask.tools.find((t) => t.name === action.tool);
      if (!tool) {
        const obs = { error: `Unknown tool: ${action.tool}` };
        history.push({ role: 'user', content: `Observation: ${JSON.stringify(obs)}` });
        continue;
      }

      // Build the per-call context. This is the only API tools have for
      // mutating engine-level state. Keep this surface narrow.
      const ctx: ToolContext = {
        manifest,
        setNextMask: (name) => {
          manifest.currentMask = name;
        },
        markComplete: () => {
          manifest.status = 'complete';
        },
        log: (msg) => console.log(`    [engine] ${msg}`),
      };

      const result = await tool.execute(action.input, ctx);
      const obsText = JSON.stringify(result.observation ?? null);
      history.push({ role: 'user', content: `Observation: ${obsText}` });

      if (result.kind === 'terminate') {
        terminated = true;
        break;
      }
    }

    if (terminated) return;
  }

  console.log(`  [engine] hit MAX_ITERATIONS_PER_STEP (${MAX_ITERATIONS_PER_STEP}) — bailing`);
}

/**
 * Top-level runner. Drives runStep over a sequence of user messages,
 * cascading mask switches between steps. After a tool morphs the mask,
 * the next iteration re-enters with the new mask — so a director→artisan
 * morph followed by an artisan auto-fire happens transparently.
 *
 * The cascade-fire pattern from autopoet's themis.ts becomes the
 * outer-loop's responsibility here: it watches `currentMask` between
 * steps. Tools never know whether they're cascading or being called by
 * the visitor — they just morph and exit.
 */
export async function runConversation(
  userMessages: string[],
  manifest: Manifest,
  llm: Llm,
): Promise<void> {
  let messageQueue = [...userMessages];

  while (manifest.status === 'active' && messageQueue.length > 0) {
    const message = messageQueue.shift()!;
    const previousMask = manifest.currentMask;
    const mask = MASK_REGISTRY[manifest.currentMask];

    console.log(`\n→ visitor: "${message}"`);
    await runStep(message, mask, manifest, llm);

    // Cascade: if the step morphed into a new mask, run that mask's first
    // turn before consuming the next visitor message. The "INTERNAL" prefix
    // tells the new mask it wasn't the visitor talking — it just took over.
    while (
      manifest.status === 'active' &&
      manifest.currentMask !== previousMask
    ) {
      const cascadingFrom = manifest.currentMask;
      const newMask = MASK_REGISTRY[manifest.currentMask];
      console.log(`\n↳ cascade-fire into '${newMask.name}'`);
      await runStep('[INTERNAL] You just took over. Continue from here.', newMask, manifest, llm);

      // If THIS cascade also morphed, loop again. Bounded by status === 'active'
      // so a chain that ends naturally exits cleanly.
      if (manifest.currentMask === cascadingFrom) break;
    }
  }
}
