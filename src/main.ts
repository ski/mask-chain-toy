/**
 * Entry point. Picks a scenario from CLI args (default: trip).
 *
 *   pnpm start                  # trip scenario (v1 — pre-existing mask chain)
 *   pnpm start renovation       # renovation scenario (v2 — agent invents tool + mask)
 *
 * Read alongside the source files in this order:
 *
 *   1. types.ts       — type surface (Tool, Mask, Op, ToolSpec, Registry)
 *   2. registry.ts    — mutable catalog + compileToolSpec (Op[] → Tool)
 *   3. tools.ts       — core tools (immutable)
 *   4. meta-tools.ts  — define_tool, define_mask, attach_tool_to_mask
 *   5. masks.ts       — core masks
 *   6. engine.ts      — the loop (no morph special-casing)
 *   7. llm-mock.ts    — scripted scenarios
 *   8. main.ts        — wire it together (this file)
 */

import { runConversation } from './engine.js';
import { createMockLlm } from './llm-mock.js';
import { CORE_MASKS } from './masks.js';
import { CORE_TOOLS } from './tools.js';
import { ATTACH_TOOL_TO_MASK, DEFINE_MASK, DEFINE_TOOL, TEST_TOOL } from './meta-tools.js';
import { bootstrap, createRegistry } from './registry.js';
import type { Manifest } from './types.js';

type Scenario = 'trip' | 'renovation';

async function main(): Promise<void> {
  const arg = (process.argv[2] ?? 'trip') as Scenario;
  if (arg !== 'trip' && arg !== 'renovation') {
    console.error(`unknown scenario: '${arg}'. Choose 'trip' or 'renovation'.`);
    process.exit(1);
  }

  const registry = createRegistry();

  // Bootstrap the runtime catalog. Core tools + masks are flagged
  // immutable so agent-defined work can't overwrite them.
  bootstrap(
    registry,
    [...CORE_TOOLS, DEFINE_TOOL, TEST_TOOL, DEFINE_MASK, ATTACH_TOOL_TO_MASK],
    CORE_MASKS,
  );

  const manifest: Manifest = {
    status: 'active',
    currentMask: 'receptionist',
    artifacts: {},
  };

  const llm = createMockLlm(arg);

  const messages =
    arg === 'trip'
      ? ['hi', 'Alice', 'I want to plan a trip somewhere quiet']
      : ['hi', 'Bob', 'I need a quote for a kitchen renovation'];

  console.log(`━━━ mask-chain-toy (scenario: ${arg}) ━━━`);
  console.log(`starting mask: ${manifest.currentMask}`);
  console.log(`registry: ${registry.tools.size} tools, ${registry.masks.size} masks`);

  await runConversation(messages, manifest, registry, llm);

  console.log('\n━━━ session complete ━━━');
  console.log('final mask:    ', manifest.currentMask);
  console.log('final status:  ', manifest.status);
  console.log(`registry now:   ${registry.tools.size} tools, ${registry.masks.size} masks`);
  console.log('agent-defined:');
  for (const [name] of registry.tools) {
    if (!registry.core.has(`tool:${name}`)) console.log(`  + tool: ${name}`);
  }
  for (const [name] of registry.masks) {
    if (!registry.core.has(`mask:${name}`)) console.log(`  + mask: ${name}`);
  }
  console.log('final artifacts:');
  for (const [k, v] of Object.entries(manifest.artifacts)) {
    console.log(`  ${k}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
