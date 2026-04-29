/**
 * Entry point. Run `pnpm start` (or `npx tsx src/main.ts`) to watch the
 * mask chain unfold. The output narrates each step — read it alongside
 * the source files in this order:
 *
 *   1. types.ts     — type surface
 *   2. engine.ts    — the loop (notice no morph special-casing)
 *   3. tools.ts     — tools, including morph tools
 *   4. masks.ts     — mask declarations
 *   5. llm-mock.ts  — scripted "model" responses
 *   6. main.ts      — wire it together (this file)
 */

import { runConversation } from './engine.js';
import { createMockLlm } from './llm-mock.js';
import type { Manifest } from './types.js';

async function main(): Promise<void> {
  const manifest: Manifest = {
    status: 'active',
    currentMask: 'receptionist',
    artifacts: {},
  };

  const llm = createMockLlm();

  // Three scripted visitor messages drive the run. The first lands in
  // receptionist; the morph happens during the third; planner cascade-
  // fires off the morph and completes the chain on its second turn.
  const visitorMessages = [
    'hi',
    'Alice',
    'I want to plan a trip somewhere quiet',
  ];

  console.log('━━━ mask-chain-toy ━━━');
  console.log(`starting mask: ${manifest.currentMask}`);

  await runConversation(visitorMessages, manifest, llm);

  console.log('\n━━━ session complete ━━━');
  console.log('final mask:    ', manifest.currentMask);
  console.log('final status:  ', manifest.status);
  console.log('final artifacts:');
  for (const [k, v] of Object.entries(manifest.artifacts)) {
    console.log(`  ${k}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
