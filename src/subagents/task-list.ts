import type { Task } from '../db/schema.js';
import { fetchTasks } from '../tools/task-fetch.js';
import { DEFAULT_SUBAGENT_MODEL, getAnthropicClient } from './anthropic.js';
import { fromAnthropicUsage, type TokenUsageSummary } from '../usage.js';

export type TaskListInput = {
  status?: Task['status'];
};

export type TaskListPayload = {
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

export type TaskListResult = {
  summary: string;
  payload: TaskListPayload;
  usage: TokenUsageSummary;
};

function buildPayload(status?: Task['status']): TaskListPayload {
  const tasks = fetchTasks(status ? { status } : {}).map((task) => ({
    id: task.id,
    title: task.title,
    effort: task.effort,
    priority: task.priority,
    durationMinutes: task.durationMinutes,
    deadlineAt: task.deadlineAt,
    status: task.status,
  }));

  return { tasks };
}

async function summarizeTaskList(
  payload: TaskListPayload,
): Promise<{ summary: string; usage: TokenUsageSummary }> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: DEFAULT_SUBAGENT_MODEL,
    max_tokens: 260,
    system:
      'You are a task list formatter. Return a concise, user-facing markdown list of tasks grouped by priority. Include id, title, effort, duration, and deadline when present. Exclude any analysis beyond a one-line count summary.',
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

export async function getTaskList(input: TaskListInput = {}): Promise<TaskListResult> {
  const payload = buildPayload(input.status);
  const result = await summarizeTaskList(payload);

  return {
    summary: result.summary,
    payload,
    usage: result.usage,
  };
}
