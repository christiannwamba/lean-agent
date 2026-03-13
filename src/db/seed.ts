import { Command } from 'commander';
import { eq } from 'drizzle-orm';

import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE, parseDeadlineText } from '../dates.js';
import { db } from './index.js';
import { energyDays, tasks, type NewEnergyDay, type NewTask } from './schema.js';

const SEED_REFERENCE = new Date(DEFAULT_REFERENCE_ISO);
const SEED_DATE = '2026-03-13';
const SEED_TIMEZONE = DEFAULT_TIMEZONE;

type EnergyScenario = {
  label: string;
  hours: number[];
};

type TaskScenarioInput = Omit<NewTask, 'deadlineAt' | 'deadlineTimezone' | 'deadlineRaw' | 'createdAt'> & {
  deadlineRaw?: string;
};

const energyScenarios: Record<string, EnergyScenario> = {
  well_rested: {
    label: 'well_rested',
    hours: [0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.6, 0.75, 0.88, 0.92, 0.85, 0.65, 0.45, 0.5, 0.62, 0.55, 0.45, 0.35, 0.25, 0.2, 0.15, 0.1, 0.1],
  },
  poor_sleep: {
    label: 'poor_sleep',
    hours: [0.1, 0.1, 0.1, 0.1, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.52, 0.48, 0.35, 0.2, 0.22, 0.3, 0.28, 0.25, 0.2, 0.18, 0.15, 0.1, 0.1, 0.1],
  },
  evening_person: {
    label: 'evening_person',
    hours: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.15, 0.2, 0.22, 0.25, 0.28, 0.3, 0.3, 0.32, 0.38, 0.45, 0.55, 0.68, 0.78, 0.82, 0.75, 0.6, 0.4, 0.2],
  },
  fragmented: {
    label: 'fragmented',
    hours: [0.1, 0.1, 0.3, 0.2, 0.1, 0.15, 0.55, 0.4, 0.2, 0.6, 0.5, 0.3, 0.2, 0.55, 0.45, 0.3, 0.2, 0.4, 0.35, 0.2, 0.15, 0.1, 0.1, 0.1],
  },
  burnout: {
    label: 'burnout',
    hours: [0.1, 0.1, 0.1, 0.1, 0.1, 0.12, 0.18, 0.22, 0.28, 0.3, 0.32, 0.3, 0.25, 0.2, 0.35, 0.32, 0.28, 0.22, 0.18, 0.15, 0.12, 0.1, 0.1, 0.1],
  },
};

const taskScenarios: Record<string, TaskScenarioInput[]> = {
  deadline_pressure: [
    { title: 'Finalize investor memo', effort: 'high', priority: 'critical', deadlineRaw: 'tomorrow at 9am', durationMinutes: 180, status: 'todo', category: 'deep_work' },
    { title: 'Ship analytics narrative', effort: 'high', priority: 'high', deadlineRaw: 'tomorrow at 10:30am', durationMinutes: 150, status: 'todo', category: 'deep_work' },
    { title: 'Reply to recruiter email', effort: 'low', priority: 'medium', durationMinutes: 20, status: 'todo', category: 'communication' },
    { title: 'Submit expense receipts', effort: 'low', priority: 'low', durationMinutes: 15, status: 'todo', category: 'admin' },
    { title: 'Schedule 1:1 follow-ups', effort: 'low', priority: 'medium', durationMinutes: 25, status: 'todo', category: 'communication' },
    { title: 'Tidy project board', effort: 'low', priority: 'low', durationMinutes: 20, status: 'todo', category: 'admin' },
  ],
  overloaded_queue: [
    { title: 'Draft onboarding revamp', effort: 'high', priority: 'high', durationMinutes: 150, status: 'todo', category: 'deep_work' },
    { title: 'Refactor billing webhook tests', effort: 'high', priority: 'medium', durationMinutes: 120, status: 'todo', category: 'deep_work' },
    { title: 'Prepare roadmap notes', effort: 'medium', priority: 'high', durationMinutes: 75, status: 'todo', category: 'creative' },
    { title: 'Review design QA screenshots', effort: 'medium', priority: 'medium', durationMinutes: 45, status: 'todo', category: 'creative' },
    { title: 'Inbox zero sprint', effort: 'low', priority: 'low', durationMinutes: 30, status: 'todo', category: 'communication' },
    { title: 'Update CRM records', effort: 'low', priority: 'low', durationMinutes: 25, status: 'todo', category: 'admin' },
    { title: 'Write launch checklist', effort: 'medium', priority: 'medium', durationMinutes: 60, status: 'todo', category: 'admin' },
    { title: 'Research competitor pricing', effort: 'medium', priority: 'low', durationMinutes: 90, status: 'todo', category: 'deep_work' },
    { title: 'Review support escalations', effort: 'medium', priority: 'high', durationMinutes: 50, status: 'todo', category: 'communication' },
    { title: 'Draft blog outline', effort: 'low', priority: 'medium', durationMinutes: 40, status: 'todo', category: 'creative' },
    { title: 'Clean up docs navigation', effort: 'low', priority: 'low', durationMinutes: 35, status: 'todo', category: 'admin' },
    { title: 'Create hiring scorecard', effort: 'medium', priority: 'medium', durationMinutes: 70, status: 'todo', category: 'admin' },
  ],
  light_day: [
    { title: 'Review weekly metrics', effort: 'medium', priority: 'medium', durationMinutes: 45, status: 'todo', category: 'admin' },
    { title: 'Reply to community questions', effort: 'low', priority: 'low', durationMinutes: 25, status: 'todo', category: 'communication' },
    { title: 'Polish team update note', effort: 'low', priority: 'medium', durationMinutes: 30, status: 'todo', category: 'creative' },
  ],
  mismatched_priorities: [
    { title: 'Design migration strategy', effort: 'high', priority: 'critical', deadlineRaw: 'in 4 days at 5pm', durationMinutes: 180, status: 'todo', category: 'deep_work' },
    { title: 'Send venue confirmation', effort: 'low', priority: 'low', deadlineRaw: 'in 3 hours', durationMinutes: 10, status: 'todo', category: 'communication' },
    { title: 'Review legal redlines', effort: 'medium', priority: 'high', deadlineRaw: 'tomorrow at 2pm', durationMinutes: 60, status: 'todo', category: 'deep_work' },
    { title: 'Update launch FAQ', effort: 'low', priority: 'medium', durationMinutes: 25, status: 'todo', category: 'admin' },
  ],
  recovery_day: [
    { title: 'Outline hiring plan', effort: 'high', priority: 'high', deadlineRaw: 'next Tuesday at 2pm', durationMinutes: 120, status: 'todo', category: 'deep_work' },
    { title: 'Draft board summary', effort: 'high', priority: 'critical', deadlineRaw: 'in 2 days at 11am', durationMinutes: 150, status: 'todo', category: 'deep_work' },
    { title: 'Plan customer interviews', effort: 'medium', priority: 'medium', durationMinutes: 90, status: 'todo', category: 'creative' },
    { title: 'Triage unread Slack threads', effort: 'medium', priority: 'low', durationMinutes: 40, status: 'todo', category: 'communication' },
  ],
};

function buildSeedEnergyDay(scenario: EnergyScenario): NewEnergyDay {
  return {
    label: scenario.label,
    date: SEED_DATE,
    timezone: SEED_TIMEZONE,
    hours: scenario.hours,
  };
}

function buildSeedTask(task: TaskScenarioInput): NewTask {
  if (!task.deadlineRaw) {
    return {
      title: task.title,
      effort: task.effort,
      priority: task.priority,
      durationMinutes: task.durationMinutes,
      status: task.status,
      category: task.category,
      deadlineAt: null,
      deadlineTimezone: null,
      deadlineRaw: null,
    };
  }

  const parsed = parseDeadlineText(task.deadlineRaw, {
    referenceInstant: SEED_REFERENCE,
    timezone: SEED_TIMEZONE,
  });

  if (!parsed) {
    throw new Error(`Failed to parse seeded deadline: ${task.deadlineRaw}`);
  }

  return {
    title: task.title,
    effort: task.effort,
    priority: task.priority,
    durationMinutes: task.durationMinutes,
    status: task.status,
    category: task.category,
    deadlineAt: parsed.deadlineAt,
    deadlineTimezone: parsed.deadlineTimezone,
    deadlineRaw: parsed.deadlineRaw,
  };
}

export async function seedDatabase(energyLabel: string, taskLabel: string): Promise<void> {
  const energyScenario = energyScenarios[energyLabel];
  const taskScenario = taskScenarios[taskLabel];

  if (!energyScenario) {
    throw new Error(`Unknown energy scenario: ${energyLabel}`);
  }

  if (!taskScenario) {
    throw new Error(`Unknown task scenario: ${taskLabel}`);
  }

  db.delete(tasks).run();
  db.delete(energyDays).run();

  db.insert(energyDays).values(buildSeedEnergyDay(energyScenario)).run();
  db.insert(tasks).values(taskScenario.map(buildSeedTask)).run();
}

function printScenarioList(): void {
  console.log(
    JSON.stringify(
      {
        energy: Object.keys(energyScenarios),
        tasks: Object.keys(taskScenarios),
        referenceInstant: DEFAULT_REFERENCE_ISO,
        timezone: DEFAULT_TIMEZONE,
      },
      null,
      2,
    ),
  );
}

const program = new Command();

program
  .name('seed')
  .description('Reset and seed the demo database with one energy scenario and one task scenario')
  .option('--list', 'List available scenarios')
  .option('--energy <label>', 'Energy scenario label')
  .option('--tasks <label>', 'Task scenario label')
  .action(async (options: { list?: boolean; energy?: string; tasks?: string }) => {
    if (options.list) {
      printScenarioList();
      return;
    }

    if (!options.energy || !options.tasks) {
      throw new Error('Both --energy and --tasks are required unless --list is used');
    }

    await seedDatabase(options.energy, options.tasks);

    const seededEnergy = db.select().from(energyDays).where(eq(energyDays.label, options.energy)).get();
    const seededTasks = db.select().from(tasks).all();

    console.log(
      JSON.stringify(
        {
          seeded: {
            energy: seededEnergy,
            tasks: {
              scenario: options.tasks,
              count: seededTasks.length,
              titles: seededTasks.map((task) => task.title),
            },
          },
        },
        null,
        2,
      ),
    );
  });

await program.parseAsync(process.argv);
