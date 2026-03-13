import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_SUBAGENT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

let cachedClient: Anthropic | undefined;

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  cachedClient ??= new Anthropic({ apiKey });
  return cachedClient;
}
