/**
 * Meta-tools — what an agent uses to extend itself.
 *
 *   - define_tool         — write a new tool (data → registered Tool)
 *   - define_mask         — write a new mask referencing already-registered tools
 *   - attach_tool_to_mask — bind an existing tool onto a mask's toolkit
 *
 * Marked as core in bootstrap so the agent can't overwrite them. The
 * tools they define are NOT core — those can be replaced or removed by
 * the agent at will (a `delete_tool` tool is a sensible add).
 *
 * Validation lives inside each tool's execute. If the agent emits a
 * malformed spec (unknown op, name collision, missing input), the tool
 * returns { kind: 'continue', observation: { error } } and the LLM
 * bounces back to re-plan. Engine never sees these as failures — same
 * uniform path as any other tool.
 */

import { compileToolSpec, isCoreMask, isCoreTool } from './registry.js';
import type { MaskSpec, Tool, ToolSpec } from './types.js';

const VALID_OPS = new Set([
  'capture',
  'observe',
  'morph',
  'complete',
  'log',
  'terminate',
]);

export const DEFINE_TOOL: Tool = {
  name: 'define_tool',
  describe:
    'Register a new tool the agent has designed. Input: { name, describe, body: Op[] }. ' +
    'Cannot overwrite a core tool. Op kinds: capture, observe, morph, complete, log, terminate.',
  execute: async (input, ctx) => {
    const spec = input as unknown as ToolSpec;
    if (typeof spec?.name !== 'string' || !spec.name) {
      return { kind: 'continue', observation: { error: 'name required' } };
    }
    if (!Array.isArray(spec.body)) {
      return { kind: 'continue', observation: { error: 'body must be Op[]' } };
    }
    if (isCoreTool(ctx.registry, spec.name)) {
      return { kind: 'continue', observation: { error: `cannot overwrite core tool '${spec.name}'` } };
    }
    for (const op of spec.body) {
      if (!op || typeof (op as { op?: unknown }).op !== 'string' || !VALID_OPS.has((op as { op: string }).op)) {
        return {
          kind: 'continue',
          observation: { error: `unknown op in body: ${JSON.stringify(op)}` },
        };
      }
    }

    const tool = compileToolSpec(spec);
    ctx.registry.tools.set(tool.name, tool);
    ctx.log(`defined tool: ${tool.name} (${spec.body.length} ops)`);
    return { kind: 'continue', observation: { ok: true, registered: tool.name } };
  },
};

export const DEFINE_MASK: Tool = {
  name: 'define_mask',
  describe:
    'Register a new mask. Input: { name, systemPrompt, tools: string[] }. ' +
    'Each tool name must already be registered. Cannot overwrite a core mask.',
  execute: async (input, ctx) => {
    const spec = input as unknown as MaskSpec;
    if (typeof spec?.name !== 'string' || !spec.name) {
      return { kind: 'continue', observation: { error: 'name required' } };
    }
    if (isCoreMask(ctx.registry, spec.name)) {
      return { kind: 'continue', observation: { error: `cannot overwrite core mask '${spec.name}'` } };
    }
    if (!Array.isArray(spec.tools) || spec.tools.length === 0) {
      return { kind: 'continue', observation: { error: 'tools must be a non-empty string[]' } };
    }

    const resolved: Tool[] = [];
    for (const name of spec.tools) {
      const tool = ctx.registry.tools.get(name);
      if (!tool) {
        return { kind: 'continue', observation: { error: `tool '${name}' not registered — define it first` } };
      }
      resolved.push(tool);
    }

    ctx.registry.masks.set(spec.name, {
      name: spec.name,
      systemPrompt: typeof spec.systemPrompt === 'string' ? spec.systemPrompt : '',
      tools: resolved,
    });
    ctx.log(`defined mask: ${spec.name} (${resolved.length} tools)`);
    return { kind: 'continue', observation: { ok: true, registered: spec.name } };
  },
};

export const ATTACH_TOOL_TO_MASK: Tool = {
  name: 'attach_tool_to_mask',
  describe:
    'Bind an already-registered tool onto a mask\'s available toolkit. ' +
    'Input: { mask: string, tool: string }. Idempotent.',
  execute: async (input, ctx) => {
    const maskName = String(input.mask ?? '');
    const toolName = String(input.tool ?? '');
    const mask = ctx.registry.masks.get(maskName);
    const tool = ctx.registry.tools.get(toolName);
    if (!mask || !tool) {
      return {
        kind: 'continue',
        observation: { error: `unknown mask '${maskName}' or tool '${toolName}'` },
      };
    }
    if (!mask.tools.find((t) => t.name === tool.name)) {
      mask.tools.push(tool);
    }
    ctx.log(`attached tool '${tool.name}' to mask '${mask.name}'`);
    return {
      kind: 'continue',
      observation: { ok: true, mask: mask.name, tool: tool.name },
    };
  },
};
