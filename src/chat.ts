import { Command } from 'commander';
import { cancel, intro, isCancel, outro, select, spinner, text } from '@clack/prompts';
import chalk from 'chalk';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { ModelMessage } from 'ai';

import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE } from './dates.js';
import {
  countSessionContext,
  runChatTurn,
  createTerminalLogger,
  prepareHistoryForTurn,
  type AgentStepTraceEntry,
  type ChatSessionConfig,
} from './agent.js';
import { getEnergyScenarioLabels, getTaskScenarioLabels, seedDatabase } from './db/seed.js';
import { renderAssistantOutput } from './ui/render.js';

type ChatOptions = {
  energy?: string;
  tasks?: string;
  hour?: string;
  ref?: string;
  tz?: string;
  traceAgent?: boolean;
};

type StartupConfig = ChatSessionConfig & {
  energyLabel: string;
  taskLabel: string;
};

const CONTEXT_TOKEN_BUDGET = 10_000;
const COMPACTION_THRESHOLD = 8_000;
const COMPACTION_KEEP_TURNS = 2;

function currentHourInTimezone(timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone,
  });

  return Number(formatter.format(new Date()));
}

async function promptForChoice(
  label: string,
  choices: Array<{ value: string; label: string; hint?: string }>,
): Promise<string> {
  const result = await select({
    message: label,
    options: choices,
  });

  if (isCancel(result)) {
    cancel('Cancelled.');
    process.exit(0);
  }

  return result;
}

async function resolveStartupConfig(options: ChatOptions): Promise<StartupConfig> {
  const timezone = options.tz ?? DEFAULT_TIMEZONE;
  const suggestedHour = currentHourInTimezone(timezone);
  const energyLabel =
    options.energy ??
    (await promptForChoice(
      'Pick an energy scenario',
      getEnergyScenarioLabels().map((value) => ({
        value,
        label: value,
      })),
    ));
  const taskLabel =
    options.tasks ??
    (await promptForChoice(
      'Pick a task scenario',
      getTaskScenarioLabels().map((value) => ({
        value,
        label: value,
      })),
    ));
  const currentHour = options.hour ? Number(options.hour) : suggestedHour;
  const referenceInstant = options.ref ?? DEFAULT_REFERENCE_ISO;

  return {
    energyLabel,
    taskLabel,
    currentHour,
    timezone,
    referenceInstant,
  };
}

async function runChat(options: ChatOptions): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY must be set to use chat');
  }

  const config = await resolveStartupConfig(options);
  await seedDatabase(config.energyLabel, config.taskLabel);
  const traceFilePath = options.traceAgent
    ? path.join(
        process.cwd(),
        'traces',
        `agent-trace-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.jsonl`,
      )
    : undefined;

  if (traceFilePath) {
    mkdirSync(path.dirname(traceFilePath), { recursive: true });
  }

  intro('lean-agent');
  console.log(`Seeded demo with energy=${config.energyLabel}, tasks=${config.taskLabel}, hour=${config.currentHour}, tz=${config.timezone}`);
  if (traceFilePath) {
  console.log(`Tracing agent steps to ${traceFilePath}`);
  }
  console.log('Type `exit` or `quit` to end the session.');
  let history: ModelMessage[] = [];
  let historySummary: string | undefined;
  let currentContextTokens = 0;
  let sessionTokenTotal = 0;
  let turnIndex = 0;

  try {
    while (true) {
      const response = await text({
        message: '>',
        placeholder: 'Ask about tasks, energy, or scheduling',
      });

      if (isCancel(response)) {
        break;
      }

      const input = response.trim();

      if (!input) {
        continue;
      }

      if (input === 'exit' || input === 'quit') {
        break;
      }

      const loading = spinner();
      let loadingActive = false;
      const stopLoading = () => {
        if (!loadingActive) {
          return;
        }

        loadingActive = false;
        loading.stop('');
      };
      const clearLoading = () => {
        if (!loadingActive) {
          return;
        }

        loadingActive = false;
        loading.clear();
      };
      const startLoading = (message = 'Thinking...') => {
        if (loadingActive) {
          return;
        }

        loadingActive = true;
        loading.start(message);
      };
      const logger = createTerminalLogger({
        immediate: true,
        beforeEachLog: clearLoading,
        afterEachLog: () => startLoading('Waiting...'),
      });
      startLoading('Thinking...');

      const compaction = await prepareHistoryForTurn({
        config,
        history,
        historySummary,
        userInput: input,
        thresholdTokens: COMPACTION_THRESHOLD,
        keepTurns: COMPACTION_KEEP_TURNS,
      });
      history = compaction.history;
      historySummary = compaction.historySummary;

      const result = await runChatTurn({
        config,
        history,
        historySummary,
        userInput: input,
        logger,
        turnIndex,
        tracer: traceFilePath
          ? {
              traceStep(entry: AgentStepTraceEntry) {
                appendFileSync(traceFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
              },
            }
          : undefined,
      });

      stopLoading();

      history = result.history;
      const turnTokenTotal =
        result.usage.total.totalTokens + compaction.usage.totalTokens;
      sessionTokenTotal += turnTokenTotal;
      turnIndex += 1;
      currentContextTokens = await countSessionContext({
        config,
        history,
        historySummary,
      });

      const rendered = renderAssistantOutput(result.assistantText);
      if (rendered) {
        console.log(rendered);
      }

      console.log(
        chalk.dim(
          `[tokens: turn ${turnTokenTotal.toLocaleString()} | session ${sessionTokenTotal.toLocaleString()} | main ${result.usage.main.totalTokens.toLocaleString()} | subagents ${result.usage.subagents.totalTokens.toLocaleString()}${compaction.compacted ? ` | compaction ${compaction.usage.totalTokens.toLocaleString()}` : ''} | context ${currentContextTokens.toLocaleString()}/${CONTEXT_TOKEN_BUDGET.toLocaleString()}]`,
        ),
      );
    }
  } finally {
    outro('Session ended.');
  }
}

const program = new Command();

program
  .name('lean-agent-chat')
  .description('Interactive chat shell for the lean-agent demo')
  .option('--energy <label>', 'Energy scenario label')
  .option('--tasks <label>', 'Task scenario label')
  .option('--hour <0-23>', 'Current hour override')
  .option('--ref <iso>', 'Reference instant override', DEFAULT_REFERENCE_ISO)
  .option('--tz <timezone>', 'IANA timezone override', DEFAULT_TIMEZONE)
  .option('--trace-agent', 'Write one JSONL trace line per model step')
  .action(runChat);

if (import.meta.main) {
  await program.parseAsync(process.argv);
}
