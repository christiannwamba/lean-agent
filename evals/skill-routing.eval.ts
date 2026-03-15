import { describe, expect, it } from 'bun:test';

import { searchToolCatalog } from '../src/agent.js';
import { latestTraceForTurn, liveDescribe, makeChatConfig, runTracedConversation, seedScenario } from './helpers.js';

describe('skill routing', () => {
  it('returns exact mapped tools for known skills before fuzzy fallback', () => {
    expect(searchToolCatalog({ skillName: 'task-fetch', query: 'show tasks' })).toEqual({
      tools: ['get_task_list'],
    });
    expect(searchToolCatalog({ skillName: 'energy-check', query: 'energy level' })).toEqual({
      tools: ['get_energy_context'],
    });
    expect(searchToolCatalog({ query: 'delete task' }).tools).toContain('delete_task');
  });
});

liveDescribe('live skill routing', () => {
  const cases = [
    ['show me my tasks', 'task-fetch'],
    ["how's my energy right now?", 'energy-check'],
    ['what should I work on next?', 'task-prioritise'],
    ['mark the investor memo task as done', 'task-update-delete'],
  ] as const;

  for (const [input, expectedSkill] of cases) {
    it(`loads ${input} via ${expectedSkill}`, async () => {
      await seedScenario();

      const result = await runTracedConversation([input], makeChatConfig());
      const turn = latestTraceForTurn(result.traces, 0);
      const firstToolCall = turn[0]?.toolCalls[0] as
        | { toolName?: string; input?: { name?: string } }
        | undefined;

      expect(firstToolCall?.toolName).toBe('load_skill');
      expect(firstToolCall?.input?.name).toBe(expectedSkill);
    });
  }
});
