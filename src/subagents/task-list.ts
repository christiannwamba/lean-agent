import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import type { Task } from '../db/schema.js';
import { fetchTasks } from '../tools/task-fetch.js';
import { DEFAULT_SUBAGENT_MODEL } from './anthropic.js';
import { fromLanguageModelUsage, type TokenUsageSummary } from '../usage.js';

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
  const response = await generateText({
    model: anthropic(DEFAULT_SUBAGENT_MODEL),
    system:
      'You are a task list formatter. Return compact markdown only: one short intro line, then one heading per priority and one bullet per task. Each bullet should include id, title, effort, duration, and deadline when present. No tables. No extra analysis.',
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

export async function getTaskList(input: TaskListInput = {}): Promise<TaskListResult> {
  const payload = buildPayload(input.status);
  const result = await summarizeTaskList(payload);

  return {
    summary: result.summary,
    payload,
    usage: result.usage,
  };
}
