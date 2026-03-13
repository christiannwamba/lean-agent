import { Command } from 'commander';
import { cancel, intro, isCancel, outro, select, spinner } from '@clack/prompts';
import type Anthropic from '@anthropic-ai/sdk';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';

import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE } from './dates.js';
import {
  COMPACTION_THRESHOLD_TOKENS,
  MAX_CONTEXT_TOKENS,
  runChatTurn,
  createTerminalLogger,
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
};

type StartupConfig = ChatSessionConfig & {
  energyLabel: string;
  taskLabel: string;
};

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

  intro('lean-agent');
  console.log(`Seeded demo with energy=${config.energyLabel}, tasks=${config.taskLabel}, hour=${config.currentHour}, tz=${config.timezone}`);
  console.log('Type `exit` or `quit` to end the session.');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let history: Anthropic.Beta.Messages.BetaMessageParam[] = [];

  try {
    while (true) {
      let input = '';
      try {
        input = (await rl.question('> ')).trim();
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ERR_USE_AFTER_CLOSE') {
          break;
        }

        throw error;
      }

      if (!input) {
        continue;
      }

      if (input === 'exit' || input === 'quit') {
        break;
      }

      const logger = createTerminalLogger();
      const loading = spinner();
      loading.start('Thinking...');

      const result = await runChatTurn({
        config,
        history,
        userInput: input,
        logger,
      });

      loading.stop('');

      history = result.history as Anthropic.Beta.Messages.BetaMessageParam[];
      logger.flush();

      const rendered = renderAssistantOutput(result.assistantText);
      if (rendered) {
        console.log(rendered);
      }

      const warning =
        result.contextTokens >= COMPACTION_THRESHOLD_TOKENS ? ' compaction-soon' : '';
      console.log(
        `[context: ${result.contextTokens.toLocaleString()} / ${MAX_CONTEXT_TOKENS.toLocaleString()} tokens${warning}]`,
      );
    }
  } finally {
    rl.close();
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
  .action(runChat);

if (import.meta.main) {
  await program.parseAsync(process.argv);
}
