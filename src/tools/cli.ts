import { Command } from 'commander';

import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE } from '../dates.js';
import { discoverSkills, loadSkill } from '../skills.js';
import { currentHourFromReference, getEnergyContext } from '../subagents/energy-context.js';
import { getTaskContext } from '../subagents/task-context.js';
import { getTaskList } from '../subagents/task-list.js';
import { createTask } from './task-create.js';
import { deleteTask } from './task-delete.js';
import { fetchEnergy } from './energy-fetch.js';
import { fetchTasks } from './task-fetch.js';
import { resolveTask } from './task-resolve.js';
import { updateTask } from './task-update.js';

const program = new Command();

program.name('tools-cli');

program
  .command('list-skills')
  .action(() => {
    console.log(JSON.stringify(discoverSkills(), null, 2));
  });

program
  .command('load-skill')
  .requiredOption('--name <name>', 'Skill name')
  .action((options: { name: string }) => {
    console.log(JSON.stringify(loadSkill(options.name), null, 2));
  });

program
  .command('fetch-tasks')
  .option('--status <status>', 'todo | in_progress | done')
  .action((options: { status?: 'todo' | 'in_progress' | 'done' }) => {
    console.log(JSON.stringify(fetchTasks(options), null, 2));
  });

program
  .command('fetch-energy')
  .option('--label <label>', 'Scenario label')
  .action((options: { label?: string }) => {
    console.log(JSON.stringify(fetchEnergy(options), null, 2));
  });

program
  .command('get-energy-context')
  .option('--hour <hour>', 'Current hour 0-23')
  .option('--label <label>', 'Scenario label')
  .option('--ref <iso>', 'Reference instant', DEFAULT_REFERENCE_ISO)
  .option('--tz <timezone>', 'IANA timezone', DEFAULT_TIMEZONE)
  .option('--include-payload', 'Include trimmed payload in the output')
  .action(async (options) => {
    const currentHour =
      options.hour !== undefined ? Number(options.hour) : currentHourFromReference(options.ref, options.tz);
    const result = await getEnergyContext({
      currentHour,
      label: options.label,
    });

    if (!options.includePayload) {
      console.log(JSON.stringify({ summary: result.summary }, null, 2));
      return;
    }

    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('get-task-context')
  .option('--ref <iso>', 'Reference instant', DEFAULT_REFERENCE_ISO)
  .option('--include-payload', 'Include trimmed payload in the output')
  .action(async (options) => {
    const result = await getTaskContext({
      referenceInstant: options.ref,
    });

    if (!options.includePayload) {
      console.log(JSON.stringify({ summary: result.summary }, null, 2));
      return;
    }

    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('get-task-list')
  .option('--status <status>', 'todo | in_progress | done')
  .option('--include-payload', 'Include trimmed payload in the output')
  .action(async (options: { status?: 'todo' | 'in_progress' | 'done'; includePayload?: boolean }) => {
    const result = await getTaskList({
      status: options.status,
    });

    if (!options.includePayload) {
      console.log(JSON.stringify({ summary: result.summary }, null, 2));
      return;
    }

    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('create-task')
  .requiredOption('--title <title>', 'Task title')
  .requiredOption('--effort <effort>', 'low | medium | high')
  .requiredOption('--priority <priority>', 'low | medium | high | critical')
  .requiredOption('--duration <minutes>', 'Duration in minutes')
  .option('--deadline <text>', 'Natural-language deadline')
  .option('--category <category>', 'deep_work | admin | communication | creative')
  .option('--tz <timezone>', 'IANA timezone', DEFAULT_TIMEZONE)
  .option('--ref <iso>', 'Reference instant', DEFAULT_REFERENCE_ISO)
  .action((options) => {
    const result = createTask({
      title: options.title,
      effort: options.effort,
      priority: options.priority,
      durationMinutes: Number(options.duration),
      deadlineRaw: options.deadline,
      category: options.category,
      timezone: options.tz,
      referenceInstant: new Date(options.ref),
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('update-task')
  .requiredOption('--id <id>', 'Task id')
  .option('--title <title>', 'Task title')
  .option('--effort <effort>', 'low | medium | high')
  .option('--priority <priority>', 'low | medium | high | critical')
  .option('--duration <minutes>', 'Duration in minutes')
  .option('--deadline <text>', 'Natural-language deadline')
  .option('--clear-deadline', 'Remove deadline')
  .option('--status <status>', 'todo | in_progress | done')
  .option('--category <category>', 'deep_work | admin | communication | creative')
  .option('--tz <timezone>', 'IANA timezone', DEFAULT_TIMEZONE)
  .option('--ref <iso>', 'Reference instant', DEFAULT_REFERENCE_ISO)
  .action((options) => {
    const fields: Record<string, unknown> = {};
    if (options.title !== undefined) fields.title = options.title;
    if (options.effort !== undefined) fields.effort = options.effort;
    if (options.priority !== undefined) fields.priority = options.priority;
    if (options.duration !== undefined) fields.durationMinutes = Number(options.duration);
    if (options.status !== undefined) fields.status = options.status;
    if (options.category !== undefined) fields.category = options.category;
    if (options.clearDeadline) {
      fields.deadlineRaw = null;
    } else if (options.deadline !== undefined) {
      fields.deadlineRaw = options.deadline;
    }

    const result = updateTask({
      id: Number(options.id),
      fields,
      timezone: options.tz,
      referenceInstant: new Date(options.ref),
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('delete-task')
  .requiredOption('--id <id>', 'Task id')
  .action((options: { id: string }) => {
    console.log(JSON.stringify(deleteTask(Number(options.id)), null, 2));
  });

program
  .command('resolve-task')
  .requiredOption('--query <query>', 'Natural-language task reference')
  .option('--limit <number>', 'Max candidates', '5')
  .action((options: { query: string; limit: string }) => {
    console.log(
      JSON.stringify(
        resolveTask({
          query: options.query,
          limit: Number(options.limit),
        }),
        null,
        2,
      ),
    );
  });

await program.parseAsync(process.argv);
