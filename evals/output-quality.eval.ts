import { expect, it } from 'bun:test';

import { judgeOutput, liveDescribe, makeChatConfig, runTracedConversation, seedScenario } from './helpers.js';

liveDescribe('output quality', () => {
  it('produces an energy-aware prioritisation for deadline pressure under poor sleep', async () => {
    await seedScenario('poor_sleep', 'deadline_pressure');
    const result = await runTracedConversation(
      ['what should I work on next?'],
      makeChatConfig({ currentHour: 11 }),
    );

    const judged = await judgeOutput({
      scenario: 'Tasks=deadline_pressure, energy=poor_sleep, hour=11',
      rubric:
        'Does the response account for low energy, deadline urgency, and recommend when to do work, not just what to do?',
      output: result.outputs[0],
    });

    expect(judged.score).toBeGreaterThanOrEqual(3);
  });

  it('produces a useful task list for schedule queries', async () => {
    await seedScenario('well_rested', 'deadline_pressure');
    const result = await runTracedConversation(
      ["what's on my schedule"],
      makeChatConfig(),
    );

    const judged = await judgeOutput({
      scenario: 'Tasks=deadline_pressure, user asked for current schedule',
      rubric:
        'Does the response clearly list open tasks, group them meaningfully, and surface deadline risk without unnecessary filler?',
      output: result.outputs[0],
    });

    expect(judged.score).toBeGreaterThanOrEqual(4);
  });
});
