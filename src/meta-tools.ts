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
import type { Manifest, MaskSpec, Tool, ToolContext, ToolFixture, ToolSpec } from './types.js';

const VALID_OPS = new Set([
  'capture',
  'observe',
  'morph',
  'complete',
  'log',
  'terminate',
  'call_tool',
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

/**
 * test_tool — verification primitive (Voyager-style, with a fixture
 * supplied by the agent instead of environmental feedback).
 *
 * The agent invented a tool. Before another mask leans on it, the agent
 * calls `test_tool` with a small fixture: input → expected outcome. If
 * the tool produces the expected shape, the runtime records it in
 * `registry.verified` and other masks can declare `verifiedOnly: true`
 * to refuse anything not in that set.
 *
 * What this does NOT cover (deliberately, for now):
 *   - Reachability through the rest of the registry. A verified tool
 *     can still call_tool into something dangerous; the fixture only
 *     exercises one path.
 *   - Side effects on external systems. A tool that writes to a real
 *     API will write during the test run too. Sandbox if you mean it.
 *   - Adversarial fixtures. The agent that wrote the tool also wrote
 *     the fixture; if it can pass its own test, it passes. A second
 *     agent ("auditor") writing fixtures for a "builder" agent's tools
 *     is the real verification loop. Not in this toy.
 *
 * That said: even this minimal shape catches "the tool I wrote doesn't
 * actually do what I claimed in its describe string." Which is the
 * commonest failure mode.
 */
export const TEST_TOOL: Tool = {
  name: 'test_tool',
  describe:
    'Run a registered tool against a fixture and mark verified on pass. ' +
    'Input: { tool, input, expects_kind?, expects_observation_keys?, expects_artifacts? }',
  execute: async (input, ctx) => {
    const fixture = input as unknown as ToolFixture;
    if (typeof fixture?.tool !== 'string' || !fixture.tool) {
      return { kind: 'continue', observation: { error: 'tool name required' } };
    }
    const target = ctx.registry.tools.get(fixture.tool);
    if (!target) {
      return { kind: 'continue', observation: { error: `tool '${fixture.tool}' not registered` } };
    }

    // Run the target against a sandbox manifest so test runs don't
    // mutate live conversation state. Tools that flip currentMask or
    // markComplete inside their body don't affect the real session.
    const sandbox: Manifest = {
      status: 'active',
      currentMask: ctx.manifest.currentMask,
      artifacts: {},
    };
    const sandboxCtx: ToolContext = {
      manifest: sandbox,
      registry: ctx.registry,
      setNextMask: () => {},
      markComplete: () => {},
      log: (m) => ctx.log(`(test:${fixture.tool}) ${m}`),
    };

    const result = await target.execute(fixture.input ?? {}, sandboxCtx);

    const errors: string[] = [];
    if (fixture.expects_kind && result.kind !== fixture.expects_kind) {
      errors.push(`kind mismatch: expected '${fixture.expects_kind}', got '${result.kind}'`);
    }
    if (fixture.expects_observation_keys?.length) {
      const obs = (result.observation ?? {}) as Record<string, unknown>;
      const present = obs && typeof obs === 'object' ? Object.keys(obs) : [];
      const missing = fixture.expects_observation_keys.filter((k) => !present.includes(k));
      if (missing.length > 0) {
        errors.push(`observation missing keys: ${missing.join(', ')}`);
      }
    }
    if (fixture.expects_artifacts) {
      for (const [k, v] of Object.entries(fixture.expects_artifacts)) {
        if (sandbox.artifacts[k] !== v) {
          errors.push(`artifact '${k}' = ${JSON.stringify(sandbox.artifacts[k])}, expected ${JSON.stringify(v)}`);
        }
      }
    }

    if (errors.length > 0) {
      ctx.log(`test_tool ${fixture.tool}: FAIL — ${errors.join('; ')}`);
      return { kind: 'continue', observation: { ok: false, errors } };
    }

    ctx.registry.verified.add(fixture.tool);
    ctx.log(`test_tool ${fixture.tool}: PASS — verified`);
    return { kind: 'continue', observation: { ok: true, verified: fixture.tool } };
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
