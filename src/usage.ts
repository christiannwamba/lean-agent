export type TokenUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export function emptyTokenUsage(): TokenUsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

export function addTokenUsage(
  left: TokenUsageSummary,
  right: TokenUsageSummary,
): TokenUsageSummary {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export function fromAnthropicUsage(usage?: {
  input_tokens: number;
  output_tokens: number;
}): TokenUsageSummary {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}
