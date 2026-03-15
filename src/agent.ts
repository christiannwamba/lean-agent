import chalk from 'chalk';
import { anthropic } from '@ai-sdk/anthropic';
import {
  generateText,
  jsonSchema,
  pruneMessages,
  stepCountIs,
  tool,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { DEFAULT_REFERENCE_ISO } from './dates.js';
import { buildSkillSummary, discoverSkills, loadSkill } from './skills.js';
import { getEnergyContext } from './subagents/energy-context.js';
import { getTaskContext } from './subagents/task-context.js';
import { getTaskList } from './subagents/task-list.js';
import { createTask } from './tools/task-create.js';
import { deleteTask } from './tools/task-delete.js';
import { resolveTask } from './tools/task-resolve.js';
import { updateTask } from './tools/task-update.js';
import {
  addTokenUsage,
  emptyTokenUsage,
  fromLanguageModelUsage,
  type TokenUsageSummary,
} from './usage.js';

type LogKind = 'skill' | 'tool' | 'subagent';

type AgentLogger = {
  log(kind: LogKind, label: string): void;
};

export type AgentStepTraceEntry = {
  turnIndex: number;
  userInput: string;
  stepNumber: number;
  activeSkillName?: string;
  activeTools: string[];
  system: string;
  messages: ModelMessage[];
  toolCalls: unknown[];
  toolResults: unknown[];
  usage: TokenUsageSummary;
  text: string;
  finishReason: string;
};

type AgentTracer = {
  traceStep(entry: AgentStepTraceEntry): void;
};

export type TerminalLogger = AgentLogger & {
  flush(): void;
};

type TerminalLoggerOptions = {
  immediate?: boolean;
  beforeEachLog?: () => void;
  afterEachLog?: () => void;
};

const DEFAULT_CHAT_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
const MAX_TOOL_STEPS = 10;
const META_TOOL_NAMES = ['load_skill', 'search_tools'] as const;
const FUNCTIONAL_TOOL_NAMES = [
  'create_task',
  'resolve_task',
  'update_task',
  'delete_task',
  'get_energy_context',
  'get_task_context',
  'get_task_list',
] as const;

type MetaToolName = (typeof META_TOOL_NAMES)[number];
type FunctionalToolName = (typeof FUNCTIONAL_TOOL_NAMES)[number];
type AnyToolName = MetaToolName | FunctionalToolName;

const functionalToolNameSchema = z.enum(FUNCTIONAL_TOOL_NAMES);

const createTaskInputSchema = z.object({
  title: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high']),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  deadlineRaw: z.string().optional(),
  durationMinutes: z.number().int().positive(),
  category: z
    .enum(['deep_work', 'admin', 'communication', 'creative'])
    .optional(),
});

const updateTaskFieldsSchema = z
  .object({
    title: z.string().min(1).optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    deadlineRaw: z.string().nullable().optional(),
    durationMinutes: z.number().int().positive().optional(),
    status: z.enum(['todo', 'in_progress', 'done']).optional(),
    category: z
      .enum(['deep_work', 'admin', 'communication', 'creative'])
      .nullable()
      .optional(),
  })
  .refine((fields) => Object.keys(fields).length > 0, {
    message: 'At least one field must be updated',
  });

const searchToolsInputSchema = z
  .object({
    skillName: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().positive().max(8).optional(),
  })
  .refine((input) => Boolean(input.skillName || input.query), {
    message: 'Provide skillName or query',
  });

const loadSkillResultSchema = z.object({
  name: z.string(),
});

const searchToolsResultSchema = z.object({
  tools: z.array(functionalToolNameSchema),
});

const FUNCTIONAL_TOOL_METADATA: Record<
  FunctionalToolName,
  {
    description: string;
    skills: string[];
    keywords: string[];
  }
> = {
  create_task: {
    description: 'Create a task from extracted or inferred fields.',
    skills: ['task-create'],
    keywords: ['create', 'add', 'new task', 'capture task'],
  },
  resolve_task: {
    description: 'Resolve a natural-language task reference to one exact task or a candidate list.',
    skills: ['task-update-delete'],
    keywords: ['resolve', 'find task', 'identify task', 'match task'],
  },
  update_task: {
    description: 'Update an existing task after an exact resolution in the current turn.',
    skills: ['task-update-delete'],
    keywords: ['update', 'mark done', 'edit', 'change', 'complete'],
  },
  delete_task: {
    description: 'Delete an existing task after exact resolution.',
    skills: ['task-update-delete'],
    keywords: ['delete', 'remove', 'cancel task'],
  },
  get_energy_context: {
    description: 'Return a compact energy summary with current level and next windows.',
    skills: ['energy-check', 'task-prioritise', 'task-create', 'task-update-delete'],
    keywords: ['energy', 'peak', 'dip', 'rebound', 'current level'],
  },
  get_task_context: {
    description: 'Return a compact task urgency and effort summary.',
    skills: ['task-prioritise', 'task-create', 'task-update-delete'],
    keywords: ['task context', 'urgency', 'effort', 'deadline buckets'],
  },
  get_task_list: {
    description: 'Return a concise markdown list of tasks grouped for display.',
    skills: ['task-fetch'],
    keywords: ['task list', 'schedule', 'show tasks', 'current tasks'],
  },
};

const SKILL_TOOL_MAP: Record<string, FunctionalToolName[]> = {
  'energy-check': ['get_energy_context'],
  'task-create': ['create_task', 'get_task_context', 'get_energy_context'],
  'task-fetch': ['get_task_list'],
  'task-prioritise': ['get_task_context', 'get_energy_context'],
  'task-update-delete': [
    'resolve_task',
    'update_task',
    'delete_task',
    'get_task_context',
    'get_energy_context',
  ],
};

export type ChatSessionConfig = {
  currentHour: number;
  timezone: string;
  referenceInstant?: string;
};

export type ChatTurnParams = {
  config: ChatSessionConfig;
  history: ModelMessage[];
  userInput: string;
  logger: AgentLogger;
  turnIndex?: number;
  tracer?: AgentTracer;
};

export type ChatTurnResult = {
  history: ModelMessage[];
  assistantText: string;
  usage: {
    main: TokenUsageSummary;
    subagents: TokenUsageSummary;
    total: TokenUsageSummary;
  };
};

function zodJsonSchema(schema: z.ZodTypeAny) {
  return zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}

function aiTool<Schema extends z.ZodTypeAny, Output>(options: {
  description: string;
  inputSchema: Schema;
  execute: (input: z.infer<Schema>) => Promise<Output> | Output;
}) {
  return tool<z.infer<Schema>, Output>(
    {
      description: options.description,
      inputSchema: jsonSchema(zodJsonSchema(options.inputSchema)),
      execute: async (input: unknown) => options.execute(options.inputSchema.parse(input)),
    } as never,
  );
}

function formatSessionContext(config: ChatSessionConfig): string {
  return [
    '## Session',
    `- Current hour: ${config.currentHour}`,
    `- Timezone: ${config.timezone}`,
    `- Reference instant: ${config.referenceInstant ?? DEFAULT_REFERENCE_ISO}`,
  ].join('\n');
}

function buildBaseSystemPrompt(config: ChatSessionConfig): string {
  const skills = discoverSkills();

  return [
    'You are a task-planning CLI assistant for a throwaway demo.',
    'Be concise, practical, and explicit about scheduling tradeoffs.',
    'Use tools for database-backed facts. Never invent task or energy state.',
    'For tool-using work, call `load_skill`, then `search_tools`.',
    '`search_tools` activates regular tools for the next step. You may call both again later to change direction.',
    'Before `update_task` or `delete_task`, call `resolve_task`. If resolution is ambiguous or missing, ask a short clarification question and do not mutate anything.',
    formatSessionContext(config),
    buildSkillSummary(skills),
  ].join('\n\n');
}

function buildStepSystemPrompt(
  config: ChatSessionConfig,
  activeSkillName?: string,
): string {
  if (!activeSkillName) {
    return buildBaseSystemPrompt(config);
  }

  const skill = loadSkill(activeSkillName);

  return [
    buildBaseSystemPrompt(config),
    '## Active Skill',
    `Current skill: ${skill.name}`,
    skill.instructions,
  ].join('\n\n');
}

function normalizeQuery(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

export function searchToolCatalog(input: z.infer<typeof searchToolsInputSchema>) {
  const limit = input.limit ?? 5;
  const exactSkillTools = input.skillName ? SKILL_TOOL_MAP[input.skillName] ?? [] : [];

  // Known skills should activate their exact toolset. Fuzzy expansion is only a fallback.
  if (exactSkillTools.length > 0) {
    return {
      tools: exactSkillTools.slice(0, limit),
    };
  }

  const queryTokens = normalizeQuery(input.query ?? '');
  const seen = new Set<FunctionalToolName>();
  const matches: Array<{
    name: FunctionalToolName;
    score: number;
  }> = [];

  if (queryTokens.length > 0) {
    for (const toolName of FUNCTIONAL_TOOL_NAMES) {
      const metadata = FUNCTIONAL_TOOL_METADATA[toolName];
      const haystack = [
        toolName,
        metadata.description,
        ...metadata.skills,
        ...metadata.keywords,
      ]
        .join(' ')
        .toLowerCase();
      const score = queryTokens.reduce(
        (total, token) => total + (haystack.includes(token) ? 12 : 0),
        0,
      );

      if (score === 0 || seen.has(toolName)) {
        continue;
      }

      matches.push({
        name: toolName,
        score,
      });
    }
  }

  return {
    tools: matches
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, limit)
      .map(({ name }) => name),
  };
}

function getLatestToolResult<TOOLS extends ToolSet, Output>(
  steps: StepResult<TOOLS>[],
  toolName: string,
  parser: z.ZodType<Output>,
): { stepNumber: number; output: Output } | undefined {
  // Walk backward so the next step follows the most recent tool decision.
  // This lets the agent change trajectory within a turn and have the latest
  // load_skill/search_tools result win over older orchestration state.
  // Example:
  //   step 0 -> load_skill(task-create)
  //   step 1 -> search_tools(create_task, get_task_context)
  //   step 2 -> load_skill(energy-check)
  //   step 3 -> search_tools(get_energy_context)
  // When preparing step 4, we want energy-check + get_energy_context, not the
  // earlier task-create toolset, so we reverse and take the first match.
  for (const step of [...steps].reverse()) {
    for (const toolResult of [...step.toolResults].reverse()) {
      if (toolResult.toolName !== toolName) {
        continue;
      }

      const parsed = parser.safeParse(toolResult.output);
      if (!parsed.success) {
        continue;
      }

      return {
        stepNumber: step.stepNumber,
        output: parsed.data,
      };
    }
  }

  return undefined;
}

function selectStepState<TOOLS extends ToolSet>(steps: StepResult<TOOLS>[]) {
  const latestSkill = getLatestToolResult(steps, 'load_skill', loadSkillResultSchema);
  const latestSearch = getLatestToolResult(
    steps,
    'search_tools',
    searchToolsResultSchema,
  );
  const shouldUseSearchResult =
    latestSearch != null &&
    (latestSkill == null || latestSearch.stepNumber >= latestSkill.stepNumber);
  const functionalTools = shouldUseSearchResult
    ? latestSearch.output.tools
    : [];

  return {
    activeSkillName: latestSkill?.output.name,
    activeTools: [...META_TOOL_NAMES, ...functionalTools] as AnyToolName[],
  };
}

function pruneConsumedOrchestrationMessages(messages: ModelMessage[]): ModelMessage[] {
  return pruneMessages({
    messages,
    reasoning: 'none',
    toolCalls: [
      {
        type: 'before-last-message',
        tools: [...META_TOOL_NAMES],
      },
    ],
    emptyMessages: 'remove',
  });
}

function normalizeSystemPrompt(system: string | undefined): string {
  return system ?? '';
}

export function buildTools(
  config: ChatSessionConfig,
  logger: AgentLogger,
  trackSubagentUsage: (usage: TokenUsageSummary) => void,
) {
  const resolvedTaskIds = new Set<number>();

  return {
    load_skill: aiTool({
      description: 'Load a skill by name so the next step can use its instructions.',
      inputSchema: z.object({
        name: z.string().describe('Skill name to load'),
      }),
      execute: ({ name }) => {
        logger.log('skill', name);
        const skill = loadSkill(name);
        return {
          name: skill.name,
        };
      },
    }),
    search_tools: aiTool({
      description:
        'Search the available regular tools and return the ones needed for the current skill or request.',
      inputSchema: searchToolsInputSchema,
      execute: (input) => {
        logger.log('tool', 'search_tools');
        return searchToolCatalog(input);
      },
    }),
    create_task: aiTool({
      description:
        'Create a new task with normalized deadline fields after the task-create skill is loaded.',
      inputSchema: createTaskInputSchema,
      execute: (input) => {
        logger.log('tool', 'create_task');
        return createTask({
          ...input,
          timezone: config.timezone,
          referenceInstant: new Date(
            config.referenceInstant ?? DEFAULT_REFERENCE_ISO,
          ),
        });
      },
    }),
    resolve_task: aiTool({
      description:
        'Resolve a natural-language task reference to one exact match or a short candidate list before mutating.',
      inputSchema: z.object({
        query: z.string().min(1),
        includeDone: z.boolean().optional(),
        limit: z.number().int().positive().max(10).optional(),
      }),
      execute: ({ query, includeDone, limit }) => {
        logger.log('tool', 'resolve_task');
        const result = resolveTask({ query, includeDone, limit });
        if (result.type === 'exact') {
          resolvedTaskIds.add(result.task.id);
        }

        return result;
      },
    }),
    update_task: aiTool({
      description:
        'Update an existing task by id after it has been exactly resolved in the current turn.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        fields: updateTaskFieldsSchema,
      }),
      execute: ({ id, fields }) => {
        logger.log('tool', 'update_task');
        if (!resolvedTaskIds.has(id)) {
          throw new Error(
            'update_task is blocked until resolve_task returns one exact task in the current turn',
          );
        }

        return updateTask({
          id,
          fields,
          timezone: config.timezone,
          referenceInstant: new Date(
            config.referenceInstant ?? DEFAULT_REFERENCE_ISO,
          ),
        });
      },
    }),
    delete_task: aiTool({
      description: 'Delete an existing task by id after exact resolution.',
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
      execute: ({ id }) => {
        logger.log('tool', 'delete_task');
        if (!resolvedTaskIds.has(id)) {
          throw new Error(
            'delete_task is blocked until resolve_task returns one exact task in the current turn',
          );
        }

        return deleteTask(id);
      },
    }),
    get_energy_context: aiTool({
      description:
        'Return a compact summary of current energy, next peak, next dip, and next rebound for the session hour.',
      inputSchema: z.object({
        currentHour: z.number().int().min(0).max(23).optional(),
        label: z.string().optional(),
      }),
      execute: async ({ currentHour, label }) => {
        logger.log('subagent', 'energy');
        const result = await getEnergyContext({
          currentHour: currentHour ?? config.currentHour,
          label,
        });
        trackSubagentUsage(result.usage);
        return {
          summary: result.summary,
        };
      },
    }),
    get_task_context: aiTool({
      description:
        'Return a compact summary grouping open tasks by deadline urgency and effort level.',
      inputSchema: z.object({}),
      execute: async () => {
        logger.log('subagent', 'tasks');
        const result = await getTaskContext({
          referenceInstant: config.referenceInstant ?? DEFAULT_REFERENCE_ISO,
        });
        trackSubagentUsage(result.usage);
        return {
          summary: result.summary,
        };
      },
    }),
    get_task_list: aiTool({
      description:
        'Return a concise markdown task list grouped for display. Use this when the user wants to see their tasks.',
      inputSchema: z.object({
        status: z.enum(['todo', 'in_progress', 'done']).optional(),
      }),
      execute: async ({ status }) => {
        logger.log('subagent', 'task-list');
        const result = await getTaskList({ status });
        trackSubagentUsage(result.usage);
        return {
          summary: result.summary,
        };
      },
    }),
  } as const;
}

export async function runChatTurn(
  params: ChatTurnParams,
): Promise<ChatTurnResult> {
  const userMessage: ModelMessage = {
    role: 'user',
    content: [{ type: 'text', text: params.userInput }],
  };
  const messages: ModelMessage[] = [...params.history, userMessage];
  let subagentUsage = emptyTokenUsage();
  const stepInputs = new Map<
    number,
    {
      activeSkillName?: string;
      activeTools: string[];
      system: string;
      messages: ModelMessage[];
    }
  >();
  const tools = buildTools(params.config, params.logger, (usage) => {
    subagentUsage = addTokenUsage(subagentUsage, usage);
  });

  const result = await generateText({
    model: anthropic(DEFAULT_CHAT_MODEL),
    system: buildBaseSystemPrompt(params.config),
    messages,
    tools,
    activeTools: [...META_TOOL_NAMES],
    stopWhen: stepCountIs(MAX_TOOL_STEPS),
    maxOutputTokens: 1_200,
    prepareStep: ({ stepNumber, steps, messages }) => {
      const stepState = selectStepState(steps);
      const nextMessages = pruneConsumedOrchestrationMessages(messages);
      const nextSystem = buildStepSystemPrompt(
        params.config,
        stepState.activeSkillName,
      );

      stepInputs.set(stepNumber, {
        activeSkillName: stepState.activeSkillName,
        activeTools: [...stepState.activeTools],
        system: nextSystem,
        messages: nextMessages,
      });

      return {
        activeTools: stepState.activeTools as Array<keyof typeof tools>,
        system: nextSystem,
        messages: nextMessages,
      };
    },
    onStepFinish: (step) => {
      const stepInput = stepInputs.get(step.stepNumber) ?? {
        activeSkillName: undefined,
        activeTools: [...META_TOOL_NAMES],
        system: normalizeSystemPrompt(buildBaseSystemPrompt(params.config)),
        messages,
      };

      params.tracer?.traceStep({
        turnIndex: params.turnIndex ?? 0,
        userInput: params.userInput,
        stepNumber: step.stepNumber,
        activeSkillName: stepInput.activeSkillName,
        activeTools: stepInput.activeTools,
        system: stepInput.system,
        messages: stepInput.messages,
        toolCalls: step.toolCalls,
        toolResults: step.toolResults,
        usage: fromLanguageModelUsage(step.usage),
        text: step.text,
        finishReason: step.finishReason,
      });
    },
  });

  const assistantText = result.text.trim();
  const assistantMessage: ModelMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: assistantText }],
  };
  const mainUsage = fromLanguageModelUsage(result.totalUsage);
  const totalUsage = addTokenUsage(mainUsage, subagentUsage);

  return {
    history: [...params.history, userMessage, assistantMessage],
    assistantText,
    usage: {
      main: mainUsage,
      subagents: subagentUsage,
      total: totalUsage,
    },
  };
}

function formatLogEntry(kind: LogKind, label: string): string {
  const prefix =
    kind === 'skill'
      ? '[skill'
      : kind === 'subagent'
        ? '[subagent'
        : '[tool';

  return chalk.dim(`${prefix}: ${label}]`);
}

export function createTerminalLogger(
  options: TerminalLoggerOptions = {},
): TerminalLogger {
  const entries: string[] = [];

  return {
    log(kind, label) {
      options.beforeEachLog?.();

      const entry = formatLogEntry(kind, label);
      if (options.immediate) {
        console.log(entry);
        options.afterEachLog?.();
        return;
      }

      entries.push(entry);
    },
    flush() {
      for (const entry of entries.splice(0, entries.length)) {
        console.log(entry);
      }
    },
  };
}
