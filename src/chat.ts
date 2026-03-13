import { Command } from 'commander';
import { cancel, intro, isCancel, outro, select, spinner, text } from '@clack/prompts';
import type Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import process from 'node:process';

import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE } from './dates.js';
import {
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
  let history: Anthropic.Beta.Messages.BetaMessageParam[] = [];
  let sessionTokenTotal = 0;

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

      const result = await runChatTurn({
        config,
        history,
        userInput: input,
        logger,
      });

      stopLoading();

      history = result.history as Anthropic.Beta.Messages.BetaMessageParam[];
      sessionTokenTotal += result.usage.total.totalTokens;

      const rendered = renderAssistantOutput(result.assistantText);
      if (rendered) {
        console.log(rendered);
      }

      console.log(
        chalk.dim(
          `[tokens: turn ${result.usage.total.totalTokens.toLocaleString()} | session ${sessionTokenTotal.toLocaleString()} | main ${result.usage.main.totalTokens.toLocaleString()} | subagents ${result.usage.subagents.totalTokens.toLocaleString()}]`,
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
  .action(runChat);

if (import.meta.main) {
  await program.parseAsync(process.argv);
}
