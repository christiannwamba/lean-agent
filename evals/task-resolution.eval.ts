import { describe, expect, it } from 'bun:test';

import {
  createTaskInDb,
  fetchTasksByStatus,
  latestTraceForTurn,
  liveDescribe,
  makeChatConfig,
  resolveTaskInDb,
  runTracedConversation,
  seedScenario,
} from './helpers.js';

describe('task resolution rules', () => {
  it('returns ambiguous for overlapping report tasks', async () => {
    await seedScenario();
    await createTaskInDb({
      title: 'Write the report',
      effort: 'medium',
      priority: 'high',
      durationMinutes: 90,
    });
    await createTaskInDb({
      title: 'Review the report',
      effort: 'low',
      priority: 'medium',
      durationMinutes: 30,
    });

    const result = (await resolveTaskInDb('report')) as {
      type: string;
      candidates: unknown[];
    };
    expect(result.type).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
  });
});

liveDescribe('live mutation safety', () => {
  it('updates an exact task only after resolve_task', async () => {
    await seedScenario();

    const result = await runTracedConversation(
      ['mark the investor memo task as done'],
      makeChatConfig(),
    );
    const turn = latestTraceForTurn(result.traces, 0);
    const calledTools = turn.flatMap((step) =>
      step.toolCalls.map((call) => (call as { toolName?: string }).toolName),
    );

    expect(calledTools).toContain('resolve_task');
    expect(calledTools).toContain('update_task');
    expect((await fetchTasksByStatus('done')).some((task) => task.title === 'Finalize investor memo')).toBe(true);
  });

  it('asks for clarification and does not mutate ambiguous references', async () => {
    await seedScenario();
    await createTaskInDb({
      title: 'Write the report',
      effort: 'medium',
      priority: 'high',
      durationMinutes: 90,
    });
    await createTaskInDb({
      title: 'Review the report',
      effort: 'low',
      priority: 'medium',
      durationMinutes: 30,
    });

    const result = await runTracedConversation(
      ['mark the report task as done'],
      makeChatConfig(),
    );
    const turn = latestTraceForTurn(result.traces, 0);
    const calledTools = turn.flatMap((step) =>
      step.toolCalls.map((call) => (call as { toolName?: string }).toolName),
    );

    expect(calledTools).toContain('resolve_task');
    expect(calledTools).not.toContain('update_task');
    expect(result.outputs[0].toLowerCase()).toContain('which');
    expect((await fetchTasksByStatus('done')).some((task) => task.title.includes('report'))).toBe(false);
  });

  it('can resolve a referential follow-up from the prior assistant list', async () => {
    await seedScenario();

    const result = await runTracedConversation(
      ['show me my tasks', 'complete the first one'],
      makeChatConfig(),
    );
    const secondTurn = latestTraceForTurn(result.traces, 1);
    const calledTools = secondTurn.flatMap((step) =>
      step.toolCalls.map((call) => (call as { toolName?: string }).toolName),
    );

    expect(calledTools).toContain('resolve_task');
    expect(calledTools).toContain('update_task');
    expect((await fetchTasksByStatus('done')).length).toBeGreaterThan(0);
  });
});
