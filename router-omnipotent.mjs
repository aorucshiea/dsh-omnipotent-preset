/**
 * router-omnipotent: all-round task-aware reasoning-mode router.
 *
 * Extends router-bootstrap-v1 with an `all` mode:
 *   - simple / non-complex tasks → RL interface restoration (minimal's
 *     think-act loop: shell + str_replace_editor first, full catalog after
 *     the first durable tool call);
 *   - complex tasks or an explicit `dev_router_mode` override → spec-style
 *     deep-think-first routing over the spec / mixed / weak / react bands.
 *
 * Everything else (first-user-text capture, near-field weak guidance,
 * dev_router_status / dev_router_mode / dev_mode_subagent) is preserved.
 *
 * Zero external imports on purpose: relative preset rows resolve bare
 * specifiers from the user home, where `@deepseek-ai/*` is not installed.
 * The router tools therefore inline a minimal schema compiler instead of
 * importing `defineTool` from `@deepseek-ai/dsh-tools`.
 */

import {
  applyPersona, bandFor, bandOf, coreFor, extractText, parseMode, personaFor, sessionMode,
  testinessFor, clamp01, isComplexTask,
} from './router-core.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'router-omnipotent'

/** Prompt assembly, the tools registry, and the LLM route must exist. */
export const inject = ['systemPrompt', 'tools', 'llm']

/** Minimal spec → JSON Schema compiler (subset of defineTool's work). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export function apply(ctx, config) {
  const overrides = new Map() // session id -> explicit mode (number 0..1)
  const agents = new Map() // session id -> Agent (live handle, in-process only)
  const firstUserText = new Map() // session id -> first REAL user message text (issue #3 fix)

  // ── 路由模式 ────────────────────────────────────────────────────────────
  // standard: RL 接口还原——首轮只有 RL 训练句 + shell/str_replace_editor。
  // spec: 深度思考优先——分类 persona + 完整 sections，首轮长思维链。
  // all: 简单任务走 standard 的 RL 接口，复杂任务/显式 override 走 spec 路由。
  const routerMode = config.routerMode === 'all' ? 'all'
    : config.routerMode === 'spec' ? 'spec'
    : 'standard'
  const RL_PERSONA = 'You are a helpful software engineer assistant.'

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    agents.set(session.id, agent)

    // issue #3 fix: capture live first-user text before the first assembly.
    const mode = overrides.get(session.id) ?? firstUserText.get(session.id) ?? sessionMode(session)
    const modelId = agent.options?.model
    const text = firstUserText.get(session.id)
      ?? extractText(session.events.find((event) => event.type === 'user/message')?.data)
      ?? ''
    const forced = overrides.has(session.id)

    // ── 模式分派 ──
    // all: simple → RL interface (minimal); complex/forced → spec routing.
    const useRlInterface = routerMode === 'standard'
      || (routerMode === 'all' && !forced && !isComplexTask(text))

    const planSection = (assembled.sections || []).find((section) => /plan/i.test(section.name))
    // Keep this preset's own persona text (creative/authoring guidance) alive
    // even when the router swaps in a routing persona.
    const ownPersona = (assembled.sections || []).find((section) => /persona/i.test(section.name))
    const ownPersonaText = ownPersona?.text || ''
    // PTC/Code Mode lives in `tools:sdk` (and any other `tools:*` sections).
    // The RL interface normally strips all sections, but this all-round preset
    // must keep the Code Mode SDK visible or `run_code` is unusable.
    const essentialSections = (assembled.sections || []).filter((section) => /^tools:/i.test(section.name))

    let sections
    let core
    let persona
    if (useRlInterface) {
      persona = RL_PERSONA + (ownPersonaText ? `\n\n${ownPersonaText}` : '')
      sections = [
        ...(planSection ? [planSection] : []),
        ...essentialSections,
        { name: 'router-persona', text: persona, order: 0 },
      ]
      // RL shape plus PTC: shell + str_replace_editor + run_code, so Code
      // Mode is immediately usable even in the simple-task fast path.
      core = new Set(['str_replace_editor', 'run_code'])
    } else {
      const routed = personaFor(mode, modelId)
      persona = ownPersonaText ? `${routed}\n\n${ownPersonaText}` : routed
      sections = applyPersona(assembled.sections, persona) // keep all other sections
      core = new Set(coreFor(mode))
      core.add('run_code') // PTC available immediately in every routing path
    }

    if (session.events.some((event) => event.type === 'tool/call')) {
      return { ...assembled, sections, contexts: [] } // promoted: full catalog
    }

    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) {
      throw new Error(`${name}: no platform shell in catalog`)
    }
    core.add(shell)

    return {
      ...assembled,
      sections,
      contexts: [],
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })

  // ── near-field routing guidance for weak mode (P14/P16/P17/P19/P20) ─────
  // Every REAL user message in a weak-mode session gets ONE fixed guidance
  // message appended to the inbox right after it (near field, cache-neutral).
  // v19: depth-adaptive — SIMPLE tasks get the fast-convergence guide;
  // COMPLEX tasks get the deep-exploration guide.
  const GUIDE_WEAK =
    '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply first, then commit and act.'
  const GUIDE_DEEP =
    '\nRouter: classify this task (build or fix) now, then adopt the matching style — build: direct production; fix: inspect-first. Think deeply about the architecture, edge cases, and integration points. Do not spend reasoning on the environment or tooling. Produce when your information is complete. End each reasoning block with a decision or an information need.'

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return
    const data = event.data ?? {}
    if (data.source?.kind !== 'user') return // only real user messages
    const text = extractText(data)
    if (!firstUserText.has(session.id) && text.trim()) {
      firstUserText.set(session.id, text.trim()) // issue #3: capture BEFORE assembly
    }
    const target = [...agents.values()].find((a) => a.session === session)
    if (target === undefined || target.inbox === undefined) return
    const mode = overrides.get(session.id) ?? firstUserText.get(session.id) ?? sessionMode(session)
    if (bandOf(mode) !== 'weak') return // strong modes need no guidance
    if (!text.trim()) return
    const guide = isComplexTask(text) ? GUIDE_DEEP : GUIDE_WEAK
    try {
      target.inbox.append('next-step', {
        id: `router-guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        source: { kind: 'plugin', plugin: 'router-omnipotent' },
        content: [{ type: 'text', text: guide }],
      })
    } catch { /* duplicate/ordering races: skip */ }
  })

  // ── router visibility & tuning (agent self-optimization) ────────────────
  const registerTool = (tool) => {
    ctx.effect(() => ctx.tools.register({
      ...tool,
      parameters: toJsonSchema(tool.parameters),
      // output.schema is already a plain JSON Schema; keep it as-is
    }))
  }

  const modeSpec = {
    mode: {
      type: 'string',
      required: true,
      description: 'band name (spec / weak / mixed / react), a 0-100 number, a 0.0-1.0 number, or auto to clear the override',
    },
  }

  function fmtMode(mode) {
    return typeof mode === 'string' ? mode : mode.toFixed(2)
  }

  registerTool({
    name: 'dev_router_status',
    description: 'Show this session\'s reasoning-mode routing: mode, band, persona, first-turn core tools, test-suppression, and whether an override is active.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(_args, exec) {
      // exec.agent is the CALLING agent (defineTool forwards it); the
      // process-wide `agents` map is only a fallback for external calls.
      const agent = exec?.agent
      const session = agent?.session ?? currentSession()
      if (session === undefined) return 'no agent session'
      const mode = overrides.get(session.id) ?? sessionMode(session)
      const modelId = agent?.options?.model ?? currentAgent()?.options?.model
      const modeLabel = routerMode === 'all'
        ? 'all (adaptive RL/spec)'
        : routerMode === 'spec' ? 'spec (deep-think-first)' : 'standard (RL interface)'
      return [
        `router-mode=${modeLabel}`,
        `mode=${fmtMode(mode)} (band=${bandFor(mode)})`,
        `persona=${personaFor(mode, modelId).replace(/\n/g, ' / ')}`,
        `core=[${[...new Set([...coreFor(mode), 'run_code'])].join(', ')}]`,
        `testiness=${testinessFor(mode)}`,
        `override=${overrides.has(session.id) ? 'yes' : 'no'}`,
      ].join('\n')
    },
  })

  registerTool({
    name: 'dev_router_mode',
    description: 'Set this session\'s reasoning mode: spec (plan-first) / weak (internal routing, model decides per task) / mixed (transition, trap) / react (doer). Accepts band names, 0-100, 0.0-1.0, or auto to return to task classification. The next request applies it.',
    parameters: modeSpec,
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute(args, exec) {
      const parsed = parseMode(args.mode)
      if (parsed === null) return `invalid mode "${args.mode}": use spec/weak/mixed/react, 0-100, 0.0-1.0, or auto`
      // Key the override to the CALLING session (exec.agent), falling back to
      // the last registered agent only for calls without an exec context.
      const session = exec?.agent?.session ?? currentSession()
      if (session === undefined) return 'no agent session'
      if (parsed === 'auto') overrides.delete(session.id)
      else overrides.set(session.id, parsed === 'weak' ? 'weak' : clamp01(parsed))
      const current = overrides.get(session.id) ?? sessionMode(session)
      return `mode=${fmtMode(current)} (band=${bandFor(current)}) — next request applies`
    },
  })

  // ── mode-isolated subagent: run a task in a DIFFERENT reasoning mode,
  //    without touching this session's trajectory.
  registerTool({
    name: 'dev_mode_subagent',
    description: 'Run one task in a DIFFERENT reasoning mode than this session, in a fresh isolated context (own system prompt). The current session trajectory is untouched. Mode: spec (plan-first) / weak (internal routing) / react (doer) / balanced. Returns the subagent\'s answer text.',
    parameters: {
      mode: { type: 'string', required: true, description: 'spec / weak / react / balanced (or 0-100)' },
      task: { type: 'string', required: true, description: 'the task to hand to the mode-isolated subagent' },
      maxTokens: { type: 'number', description: 'output cap (default 1024)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const parsed = parseMode(args.mode)
      if (parsed === null || parsed === 'auto') return `invalid mode "${args.mode}"`
      const session = currentSession()
      const agent = session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
      if (agent === undefined || agent.options === undefined) return 'no agent route available'
      const { provider, model } = agent.options
      if (!provider || !model) return 'agent route missing provider/model'

      const persona = personaFor(parsed, model)
      const maxTokens = Number(args.maxTokens || 1024)
      let text = ''
      let reasoningChars = 0
      try {
        const stream = ctx.llm.stream({
          provider,
          model,
          system: persona,
          messages: [{ role: 'user', content: [{ type: 'text', text: String(args.task) }] }],
          maxTokens,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
        }
      } catch (error) {
        return `subagent error: ${error && error.message ? error.message : String(error)}`
      }
      const head = text.slice(0, 3000)
      return `[mode-subagent ${bandFor(parsed)} | reasoning ${reasoningChars} chars]\n${head}${text.length > 3000 ? '\n…(truncated)' : ''}`
    },
  })

  function currentSession() {
    // There is no `agent` service in the runtime — the registry is `agents`
    // (a Map keyed by agent). Prefer the most recently registered one.
    const last = [...agents.values()].at(-1)
    return last?.session
  }

  function currentAgent() {
    const session = currentSession()
    return session === undefined ? undefined : [...agents.values()].find((a) => a.session === session)
  }
}
