/**
 * The mutable runtime catalog of tools + masks. v1 used a frozen module-
 * level constant; v2 wraps the maps so meta-tools can mutate them.
 *
 * Two helpers live here:
 *
 *   - `compileToolSpec` — turns a structured ToolSpec (agent-emitted data)
 *     into a real Tool with an execute() function. This is how the agent
 *     "writes code": it describes the tool's behaviour as a sequence of
 *     ops, and the runtime interprets them. No eval, no new Function.
 *
 *   - `bootstrap` — pre-loads core tools + masks marked immutable.
 */

import type {
  Mask,
  MaskName,
  Op,
  Registry,
  Tool,
  ToolContext,
  ToolResult,
  ToolSpec,
} from './types.js';

export function createRegistry(): Registry {
  return {
    tools: new Map(),
    masks: new Map(),
    core: new Set(),
    verified: new Set(),
  };
}

export function bootstrap(
  registry: Registry,
  coreTools: Tool[],
  coreMasks: Mask[],
): void {
  for (const tool of coreTools) {
    registry.tools.set(tool.name, tool);
    registry.core.add(`tool:${tool.name}`);
  }
  for (const mask of coreMasks) {
    registry.masks.set(mask.name, mask);
    registry.core.add(`mask:${mask.name}`);
  }
}

/**
 * Compile a ToolSpec (data) into a Tool (function). The interpreter walks
 * each op in sequence, mutating the manifest / observation / kind as it
 * goes. The agent expressed a behaviour; the engine executes it.
 *
 * To give the agent a new building block, add a case here. The DSL is
 * intentionally tiny — anything beyond simple capture / observe / morph
 * gets implemented as a core tool, and the agent just composes with it.
 */
export function compileToolSpec(spec: ToolSpec): Tool {
  return {
    name: spec.name,
    describe: spec.describe,
    execute: async (
      input: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolResult> => {
      let observation: unknown = { ok: true };
      let kind: 'continue' | 'terminate' = 'continue';

      for (const op of spec.body) {
        switch (op.op) {
          case 'capture': {
            const value =
              op.from === 'literal'
                ? op.value
                : (input as Record<string, unknown>)[op.path];
            ctx.manifest.artifacts[op.field] = value;
            break;
          }
          case 'observe':
            observation = op.value;
            break;
          case 'morph':
            ctx.setNextMask(op.to);
            break;
          case 'complete':
            ctx.markComplete();
            break;
          case 'log':
            ctx.log(`(agent-defined: ${spec.name}) ${op.message}`);
            break;
          case 'terminate':
            kind = 'terminate';
            break;
          case 'call_tool': {
            // Composition primitive. The invented tool delegates to an
            // already-registered tool, then captures the observation into
            // the manifest. This is what lets a renovation tool actually
            // call lookup_options instead of returning a literal.
            const inner = ctx.registry.tools.get(op.tool);
            if (!inner) {
              ctx.log(`call_tool: '${op.tool}' not registered — skipped`);
              ctx.manifest.artifacts[op.capture_to] = { error: `unknown tool: ${op.tool}` };
              break;
            }
            const result = await inner.execute(op.input ?? {}, ctx);
            ctx.manifest.artifacts[op.capture_to] = result.observation ?? null;
            // If the inner tool said terminate, propagate. Otherwise keep
            // walking the body.
            if (result.kind === 'terminate') kind = 'terminate';
            break;
          }
          default: {
            // Unknown op — log + skip rather than crash.
            const unknown = op as { op: string };
            ctx.log(`compileToolSpec: unknown op '${unknown.op}' in '${spec.name}' — skipped`);
          }
        }
      }

      return { kind, observation } as ToolResult;
    },
  };
}

export function isCoreTool(registry: Registry, name: string): boolean {
  return registry.core.has(`tool:${name}`);
}

export function isCoreMask(registry: Registry, name: MaskName): boolean {
  return registry.core.has(`mask:${name}`);
}
