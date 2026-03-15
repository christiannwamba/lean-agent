import { anthropic } from '@ai-sdk/anthropic';
import { generateText, Output, type ModelMessage } from 'ai';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import {
  createTerminalLogger,
  runChatTurn,
  type AgentStepTraceEntry,
  type ChatSessionConfig,
} from '../src/agent.js';
import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE } from '../src/dates.js';
import { seedDatabase } from '../src/db/seed.js';
import { createTask } from '../src/tools/task-create.js';
import { fetchTasks } from '../src/tools/task-fetch.js';
import { resolveTask } from '../src/tools/task-resolve.js';
import {
  addTokenUsage,
  type TokenUsageSummary,
} from '../src/usage.js';

export const hasAnthropicApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

export const liveDescribe = hasAnthropicApiKey ? describe : describe.skip;
export const liveTest = hasAnthropicApiKey ? it : it.skip;

export function makeChatConfig(
  overrides: Partial<ChatSessionConfig> = {},
): ChatSessionConfig {
  return {
    currentHour: 11,
    timezone: DEFAULT_TIMEZONE,
    referenceInstant: DEFAULT_REFERENCE_ISO,
    ...overrides,
  };
}

export async function seedScenario(
  energy = 'well_rested',
  tasks = 'deadline_pressure',
): Promise<void> {
  await seedDatabase(energy, tasks);
}

export async function createTaskInDb(input: {
  title: string;
  effort: 'low' | 'medium' | 'high';
  priority: 'low' | 'medium' | 'high' | 'critical';
  durationMinutes: number;
  deadlineRaw?: string;
  category?: 'deep_work' | 'admin' | 'communication' | 'creative';
}): Promise<void> {
  createTask(input);
}

export async function resolveTaskInDb(query: string): Promise<unknown> {
  return resolveTask({ query });
}

export async function fetchTasksByStatus(
  status: 'todo' | 'in_progress' | 'done',
): Promise<Array<{ id: number; title: string; status: string }>> {
  return fetchTasks({ status }).map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
  }));
}

export async function runTracedConversation(
  inputs: string[],
  config: ChatSessionConfig = makeChatConfig(),
): Promise<{
  outputs: string[];
  traces: AgentStepTraceEntry[];
  usage: {
    main: TokenUsageSummary;
    subagents: TokenUsageSummary;
    total: TokenUsageSummary;
  };
}> {
  const logger = createTerminalLogger({ immediate: false });
  const traces: AgentStepTraceEntry[] = [];
  const outputs: string[] = [];
  let history: ModelMessage[] = [];
  let usage = {
    main: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    subagents: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    total: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };

  for (const [turnIndex, input] of inputs.entries()) {
    const result = await runChatTurn({
      config,
      history,
      userInput: input,
      logger,
      turnIndex,
      tracer: {
        traceStep(entry) {
          traces.push(entry);
        },
      },
    });

    history = result.history;
    outputs.push(result.assistantText);
    usage = {
      main: addTokenUsage(usage.main, result.usage.main),
      subagents: addTokenUsage(usage.subagents, result.usage.subagents),
      total: addTokenUsage(usage.total, result.usage.total),
    };
  }

  return { outputs, traces, usage };
}

export function latestTraceForTurn(
  traces: AgentStepTraceEntry[],
  turnIndex: number,
): AgentStepTraceEntry[] {
  return traces
    .filter((trace) => trace.turnIndex === turnIndex)
    .sort((left, right) => left.stepNumber - right.stepNumber);
}

export async function judgeOutput(input: {
  scenario: string;
  output: string;
  rubric: string;
}): Promise<{ score: number; reasoning: string }> {
  const response = await generateText({
    model: anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'),
    output: Output.object({
      schema: z.object({
        score: z.number().int(),
        reasoning: z.string(),
      }),
    }),
    system: [
      'You are an eval judge.',
      'Score the output from 1 to 5 against the rubric.',
      'Return strict JSON: {"score": <1-5>, "reasoning": "<short reason>"}',
    ].join(' '),
    prompt: `Scenario: ${input.scenario}\nRubric: ${input.rubric}\nOutput:\n${input.output}`,
  });

  const output = response.output;
  if (output.score < 1 || output.score > 5) {
    throw new Error(`Judge returned out-of-range score: ${output.score}`);
  }

  return output;
}

export function assertNoExplicitMaxTokenCaps(paths: string[]): void {
  for (const filePath of paths) {
    const content = readFileSync(filePath, 'utf8');
    expect(content).not.toMatch(/\bmax_tokens\b/);
    expect(content).not.toMatch(/\bmaxTokens\b/);
  }
}
