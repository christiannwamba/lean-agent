import path from 'node:path';
import { describe, expect, it } from 'bun:test';

import { latestTraceForTurn, liveDescribe, makeChatConfig, runTracedConversation, seedScenario, assertNoExplicitMaxTokenCaps } from './helpers.js';

describe('usage regression', () => {
  it('keeps explicit max token caps out of runtime source files', () => {
    assertNoExplicitMaxTokenCaps([
      path.join(process.cwd(), 'src/agent.ts'),
      path.join(process.cwd(), 'src/subagents/energy-context.ts'),
      path.join(process.cwd(), 'src/subagents/task-context.ts'),
      path.join(process.cwd(), 'src/subagents/task-list.ts'),
    ]);
  });
});

liveDescribe('live usage regression', () => {
  it('aggregates turn usage as main plus subagents', async () => {
    await seedScenario();
    const result = await runTracedConversation(
      ["what's on my schedule"],
      makeChatConfig(),
    );

    expect(result.usage.total.totalTokens).toBe(
      result.usage.main.totalTokens + result.usage.subagents.totalTokens,
    );
  });

  it('narrows task-fetch execution to get_task_list only', async () => {
    await seedScenario();
    const result = await runTracedConversation(
      ["what's on my schedule"],
      makeChatConfig(),
    );
    const turn = latestTraceForTurn(result.traces, 0);
    const executorSteps = turn.filter((step) => step.stepNumber >= 2);

    for (const step of executorSteps) {
      expect(step.activeTools).toEqual(['load_skill', 'search_tools', 'get_task_list']);
    }
  });

  it('records enough trace data to explain high-cost turns', async () => {
    await seedScenario();
    const result = await runTracedConversation(
      ['hi', "what's on my schedule"],
      makeChatConfig(),
    );
    const secondTurn = latestTraceForTurn(result.traces, 1);

    expect(secondTurn.length).toBeGreaterThan(1);
    for (const step of secondTurn) {
      expect(step.system.length).toBeGreaterThan(0);
      expect(step.messages.length).toBeGreaterThan(0);
      expect(step.activeTools.length).toBeGreaterThan(0);
      expect(step.usage.totalTokens).toBeGreaterThan(0);
    }
  });
});
