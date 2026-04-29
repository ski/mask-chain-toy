/**
 * The engine. Read it and notice what ISN'T here. There's no
 * `if (action.tool === mask.terminalTool)` magic. No `emit.morph` callback.
 * Every tool — regular, morph, meta — runs through the same path.
 *
 * The engine knows about: steps, observations, terminate signals,
 * iteration caps. It does NOT know about: morphs, terminal tools,
 * mask transitions. Those concepts live in the tools themselves
 * (see `tools.ts` for `morph_to_planner` and `meta-tools.ts` for the
 * self-modification primitives).
 */

import type { HistoryItem, Llm, Manifest, Mask, Registry, ToolContext } from './types.js';

const MAX_ITERATIONS_PER_STEP = 10;

export async function runStep(
  userMessage: string,
  mask: Mask,
  manifest: Manifest,
  registry: Registry,
  llm: Llm,
): Promise<void> {
  const history: HistoryItem[] = [{ role: 'user', content: userMessage }];

  for (let iter = 0; iter < MAX_ITERATIONS_PER_STEP; iter++) {
    const turn = await llm.respond(mask, history);
    console.log(`  [${mask.name}] ${turn.patter}`);
    history.push({ role: 'assistant', content: JSON.stringify(turn) });

    if (turn.actions.length === 0) return;

    let terminated = false;
    for (const action of turn.actions) {
      // v2: tools come from the mutable registry, not the mask's frozen array.
      // (The mask still tells us which tools it has access to, but the
      // *implementation* lives in the registry — meta-tools may have just
      // added a new one mid-step.)
      const tool = mask.tools.find((t) => t.name === action.tool);
      if (!tool) {
        const obs = { error: `Unknown tool for mask '${mask.name}': ${action.tool}` };
        history.push({ role: 'user', content: `Observation: ${JSON.stringify(obs)}` });
        continue;
      }

      const ctx: ToolContext = {
        manifest,
        registry,
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
 * the next iteration re-enters with the new mask.
 *
 * Cascade-fire: when `currentMask` changes between steps, run the new
 * mask's first turn with an INTERNAL message (not a real visitor reply).
 * Bounded by status === 'active' and previousMask comparison.
 */
export async function runConversation(
  userMessages: string[],
  manifest: Manifest,
  registry: Registry,
  llm: Llm,
): Promise<void> {
  const messageQueue = [...userMessages];

  while (manifest.status === 'active' && messageQueue.length > 0) {
    const message = messageQueue.shift()!;
    const previousMask = manifest.currentMask;
    const mask = registry.masks.get(manifest.currentMask);
    if (!mask) {
      console.log(`[engine] no mask registered for '${manifest.currentMask}' — bailing`);
      return;
    }

    console.log(`\n→ visitor: "${message}"`);
    await runStep(message, mask, manifest, registry, llm);

    while (
      manifest.status === 'active' &&
      manifest.currentMask !== previousMask
    ) {
      const cascadingFrom = manifest.currentMask;
      const newMask = registry.masks.get(manifest.currentMask);
      if (!newMask) {
        console.log(`[engine] cascade target '${manifest.currentMask}' not in registry — bailing`);
        return;
      }
      console.log(`\n↳ cascade-fire into '${newMask.name}'`);
      await runStep('[INTERNAL] You just took over. Continue from here.', newMask, manifest, registry, llm);
      if (manifest.currentMask === cascadingFrom) break;
    }
  }
}
