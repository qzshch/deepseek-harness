import { describe, expect, it } from 'vitest'
import { type Agent, type AgentOptions } from '@deepseek-ai/dsh-agent'

import { resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent'

function fakeParent(overrides: {
  options?: Partial<AgentOptions>
  headerConfig?: { provider: string; model: string }
}): Agent {
  const { options = {}, headerConfig } = overrides
  return {
    id: 'parent-1' as never,
    options,
    session: {
      requestHeader: () => headerConfig === undefined ? undefined : { config: headerConfig },
    },
  } as unknown as Agent
}

describe('resolveChildAgentOptions', () => {
  it('inherits the parent options when the parent session has no request header', () => {
    const parent = fakeParent({ options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      subagentDepth: 1,
    })
  })

  it('prefers the parent session request header over the frozen options', () => {
    // The web model-selection waterfall routes the parent's live requests
    // through the logged header, so the child must follow that route instead of
    // the options frozen at create/resume time.
    const parent = fakeParent({
      options: { provider: 'ark', model: 'deepseek-v4-flash' },
      headerConfig: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      subagentDepth: 1,
    })
  })

  it('carries maxTokens from the parent options regardless of the header', () => {
    const parent = fakeParent({
      options: { provider: 'ark', model: 'deepseek-v4-flash', maxTokens: 393216 },
      headerConfig: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    expect(resolveChildAgentOptions(parent, undefined, 2)).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      maxTokens: 393216,
      subagentDepth: 2,
    })
  })

  it('keeps explicit per-child overrides on top of the inherited route', () => {
    const parent = fakeParent({
      options: { provider: 'ark', model: 'deepseek-v4-flash' },
      headerConfig: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const requested: AgentOptions = { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash' }
    expect(resolveChildAgentOptions(parent, requested, 1)).toEqual({
      provider: 'siliconflow',
      model: 'deepseek-ai/DeepSeek-V4-Flash',
      subagentDepth: 1,
    })
  })

  it('resolves an empty child route when neither options nor header carry a model', () => {
    const parent = fakeParent({})
    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({ subagentDepth: 1 })
  })
})
