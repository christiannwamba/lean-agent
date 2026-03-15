import { expect, it } from 'bun:test';

import {
  fetchTasksByStatus,
  latestTraceForTurn,
  liveDescribe,
  makeChatConfig,
  runTracedConversation,
  seedScenario,
} from './helpers.js';

function toolNamesForTurn(traces: ReturnType<typeof latestTraceForTurn>): string[] {
  return traces.flatMap((step) =>
    step.toolCalls.map((call) => (call as { toolName?: string }).toolName ?? ''),
  );
}

liveDescribe('trajectory handling', () => {
  it('stays on trajectory across multiple turns and follow-ups', async () => {
    await seedScenario();

    const result = await runTracedConversation(
      ['show me my tasks', 'which one is due first?', 'mark that one done'],
      makeChatConfig(),
    );

    expect(result.outputs[1].toLowerCase()).toContain('finalize investor memo');

    const finalTurnTools = toolNamesForTurn(latestTraceForTurn(result.traces, 2));
    expect(finalTurnTools).toContain('resolve_task');
    expect(finalTurnTools).toContain('update_task');

    const doneTasks = await fetchTasksByStatus('done');
    expect(doneTasks.some((task) => task.title === 'Finalize investor memo')).toBe(true);
  });

  it('can change trajectory and then return to the earlier task safely', async () => {
    await seedScenario();

    const result = await runTracedConversation(
      ['show me my tasks', "actually, how's my energy right now?", 'okay, mark the first one done'],
      makeChatConfig(),
    );

    const energyTurnTools = toolNamesForTurn(latestTraceForTurn(result.traces, 1));
    expect(energyTurnTools).toContain('load_skill');
    expect(result.outputs[1].toLowerCase()).toMatch(/energy|peak|dip|rebound/);

    const finalTurnTools = toolNamesForTurn(latestTraceForTurn(result.traces, 2));
    expect(finalTurnTools).toContain('resolve_task');
    expect(finalTurnTools).toContain('update_task');

    const doneTasks = await fetchTasksByStatus('done');
    expect(doneTasks.some((task) => task.title === 'Finalize investor memo')).toBe(true);
  });
});
