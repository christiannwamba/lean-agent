import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import type { Task } from '../db/schema.js';
import { DEFAULT_REFERENCE_ISO } from '../dates.js';
import { fetchTasks } from '../tools/task-fetch.js';
import { DEFAULT_SUBAGENT_MODEL } from './anthropic.js';
import { fromLanguageModelUsage, type TokenUsageSummary } from '../usage.js';

export type TaskContextInput = {
  referenceInstant?: string;
};

export type TaskContextPayload = {
  referenceInstant: string;
  tasks: Array<{
    id: number;
    title: string;
    effort: Task['effort'];
    priority: Task['priority'];
    durationMinutes: number;
    deadlineAt: string | null;
    status: Task['status'];
  }>;
};

export type TaskContextResult = {
  summary: string;
  payload: TaskContextPayload;
  usage: TokenUsageSummary;
};

function buildPayload(referenceInstant: string): TaskContextPayload {
  const tasks = fetchTasks().map((task) => ({
    id: task.id,
    title: task.title,
    effort: task.effort,
    priority: task.priority,
    durationMinutes: task.durationMinutes,
    deadlineAt: task.deadlineAt,
    status: task.status,
  }));

  return {
    referenceInstant,
    tasks,
  };
}

async function summarizeTaskContext(
  payload: TaskContextPayload,
): Promise<{ summary: string; usage: TokenUsageSummary }> {
  const response = await generateText({
    model: anthropic(DEFAULT_SUBAGENT_MODEL),
    system:
      'You are a task analyst. Group tasks by deadline urgency (overdue, within 8h, within 24h, later, no deadline) and effort level. Return a compact summary. Max 80 tokens.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      },
    ],
  });
  return {
    summary: response.text.trim(),
    usage: fromLanguageModelUsage(response.usage),
  };
}

export async function getTaskContext(input: TaskContextInput = {}): Promise<TaskContextResult> {
  const payload = buildPayload(input.referenceInstant ?? DEFAULT_REFERENCE_ISO);
  const result = await summarizeTaskContext(payload);

  return {
    summary: result.summary,
    payload,
    usage: result.usage,
  };
}
