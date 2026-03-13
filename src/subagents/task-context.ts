import type { Task } from '../db/schema.js';
import { DEFAULT_REFERENCE_ISO } from '../dates.js';
import { fetchTasks } from '../tools/task-fetch.js';
import { DEFAULT_SUBAGENT_MODEL, getAnthropicClient } from './anthropic.js';
import { fromAnthropicUsage, type TokenUsageSummary } from '../usage.js';

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
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: DEFAULT_SUBAGENT_MODEL,
    max_tokens: 160,
    system:
      'You are a task analyst. Group tasks by deadline urgency (overdue, within 8h, within 24h, later, no deadline) and effort level. Return a compact summary. Max 80 tokens.',
    messages: [
      {
        role: 'user',
        content: JSON.stringify(payload),
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return {
    summary: textBlock?.text.trim() ?? '',
    usage: fromAnthropicUsage(response.usage),
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
