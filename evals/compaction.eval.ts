import { expect } from 'bun:test';
import type { ModelMessage } from 'ai';

import {
  countSessionContext,
  prepareHistoryForTurn,
} from '../src/agent.js';
import { liveDescribe, liveTest, makeChatConfig } from './helpers.js';

function textMessage(
  role: 'user' | 'assistant',
  text: string,
): ModelMessage {
  return {
    role,
    content: [{ type: 'text', text }],
  };
}

liveDescribe('compaction', () => {
  liveTest('counts projected context on the first turn before any compaction is needed', async () => {
    const config = makeChatConfig();
    const result = await prepareHistoryForTurn({
      config,
      history: [],
      userInput: 'hi',
      thresholdTokens: 8_000,
      keepTurns: 2,
    });

    expect(result.compacted).toBe(false);
    expect(result.contextTokens).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBe(0);

    const currentContext = await countSessionContext({
      config,
      history: result.history,
      historySummary: result.historySummary,
    });
    expect(currentContext).toBeGreaterThanOrEqual(0);
  });

  liveTest('compacts older turns into a summary and keeps the last two turns', async () => {
    const history: ModelMessage[] = [
      textMessage('user', 'Show me my tasks'),
      textMessage(
        'assistant',
        'Your tasks are Finalize investor memo and Ship analytics narrative.',
      ),
      textMessage('user', 'How is my energy right now?'),
      textMessage(
        'assistant',
        'Your energy is medium right now with a dip later this afternoon.',
      ),
      textMessage('user', 'What should I work on next?'),
      textMessage(
        'assistant',
        'Work on Finalize investor memo first because it is due soon.',
      ),
    ];

    const result = await prepareHistoryForTurn({
      config: makeChatConfig(),
      history,
      userInput: 'Mark the first one done',
      thresholdTokens: 1,
      keepTurns: 2,
    });

    expect(result.compacted).toBe(true);
    expect(result.history).toHaveLength(4);
    expect(result.historySummary).toBeTruthy();
    expect(result.historySummary).toContain('Finalize investor memo');
    expect(result.history[0]).toEqual(history[2]);
    expect(result.history[1]).toEqual(history[3]);
    expect(result.history[2]).toEqual(history[4]);
    expect(result.history[3]).toEqual(history[5]);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.contextTokens).toBeGreaterThan(0);
  });
});
