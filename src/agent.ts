import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import chalk from "chalk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE } from "./dates.js";
import { buildSkillSummary, discoverSkills, loadSkill } from "./skills.js";
import { getAnthropicClient } from "./subagents/anthropic.js";
import { getEnergyContext } from "./subagents/energy-context.js";
import { getTaskContext } from "./subagents/task-context.js";
import { getTaskList } from "./subagents/task-list.js";
import { createTask } from "./tools/task-create.js";
import { deleteTask } from "./tools/task-delete.js";
import { resolveTask } from "./tools/task-resolve.js";
import { updateTask } from "./tools/task-update.js";

type LogKind = "skill" | "tool" | "subagent";

type AgentLogger = {
  log(kind: LogKind, label: string): void;
};

export type TerminalLogger = AgentLogger & {
  flush(): void;
};

type TerminalLoggerOptions = {
  immediate?: boolean;
  beforeEachLog?: () => void;
  afterEachLog?: () => void;
};

export const MAX_CONTEXT_TOKENS = 10_000;
export const COMPACTION_THRESHOLD_TOKENS = 8_000;
const DEFAULT_CHAT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

export type ChatSessionConfig = {
  currentHour: number;
  timezone: string;
  referenceInstant?: string;
};

export type ChatTurnParams = {
  config: ChatSessionConfig;
  history: Anthropic.Beta.Messages.BetaMessageParam[];
  userInput: string;
  logger: AgentLogger;
};

export type ChatTurnResult = {
  history: Anthropic.Beta.Messages.BetaMessageParam[];
  assistantText: string;
  contextTokens: number;
};

const createTaskInputSchema = z.object({
  title: z.string().min(1),
  effort: z.enum(["low", "medium", "high"]),
  priority: z.enum(["low", "medium", "high", "critical"]),
  deadlineRaw: z.string().optional(),
  durationMinutes: z.number().int().positive(),
  category: z
    .enum(["deep_work", "admin", "communication", "creative"])
    .optional(),
});

const updateTaskFieldsSchema = z
  .object({
    title: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    deadlineRaw: z.string().nullable().optional(),
    durationMinutes: z.number().int().positive().optional(),
    status: z.enum(["todo", "in_progress", "done"]).optional(),
    category: z
      .enum(["deep_work", "admin", "communication", "creative"])
      .nullable()
      .optional(),
  })
  .refine((fields) => Object.keys(fields).length > 0, {
    message: "At least one field must be updated",
  });

function json(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

function zodTool<Schema extends z.ZodTypeAny>(options: {
  name: string;
  description: string;
  inputSchema: Schema;
  run: (args: z.infer<Schema>) => Promise<string> | string;
}) {
  const inputSchema = zodToJsonSchema(options.inputSchema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;

  if (inputSchema.type !== "object") {
    throw new Error(`Tool ${options.name} requires an object input schema`);
  }

  return betaTool({
    name: options.name,
    description: options.description,
    inputSchema: inputSchema as never,
    run: async (args) => options.run(options.inputSchema.parse(args)),
  });
}

function formatSessionContext(config: ChatSessionConfig): string {
  return [
    "## Session",
    `- Current hour: ${config.currentHour}`,
    `- Timezone: ${config.timezone}`,
    `- Reference instant: ${config.referenceInstant ?? DEFAULT_REFERENCE_ISO}`,
  ].join("\n");
}

function extractAssistantText(message: Anthropic.Beta.Messages.BetaMessage): string {
  return message.content
    .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function buildSystemPrompt(config: ChatSessionConfig): string {
  const skills = discoverSkills();

  return [
    "You are a task-planning CLI assistant for a throwaway demo.",
    "Be concise, practical, and explicit about scheduling tradeoffs.",
    "Before acting on a task or energy request, load the relevant skill with `load_skill`.",
    "Use `resolve_task` before any update or delete.",
    "If `resolve_task` returns multiple candidates or none, ask a short clarification question and do not mutate anything.",
    "Only call `update_task` or `delete_task` after `resolve_task` returns one exact task in the current turn.",
    "Use `get_energy_context`, `get_task_context`, and `get_task_list` for read access. Do not expect raw database fetch tools.",
    "Never invent database state. Use tools.",
    formatSessionContext(config),
    buildSkillSummary(skills),
  ].join("\n\n");
}

export function buildTools(config: ChatSessionConfig, logger: AgentLogger) {
  const resolvedTaskIds = new Set<number>();

  return [
    zodTool({
      name: "load_skill",
      description:
        "Load specialized instructions for a skill before performing the task.",
      inputSchema: z.object({
        name: z.string().describe("Skill name to load"),
      }),
      run: ({ name }) => {
        logger.log("skill", name);
        return loadSkill(name).instructions;
      },
    }),
    zodTool({
      name: "create_task",
      description:
        "Create a new task with normalized deadline fields. Use after loading the task-create skill.",
      inputSchema: createTaskInputSchema,
      run: (input) => {
        logger.log("tool", "create_task");
        return json(
          createTask({
            ...input,
            timezone: config.timezone,
            referenceInstant: new Date(
              config.referenceInstant ?? DEFAULT_REFERENCE_ISO,
            ),
          }),
        );
      },
    }),
    zodTool({
      name: "resolve_task",
      description:
        "Resolve a natural-language task reference to one exact match or a short candidate list before mutating.",
      inputSchema: z.object({
        query: z.string().min(1),
        includeDone: z.boolean().optional(),
        limit: z.number().int().positive().max(10).optional(),
      }),
      run: ({ query, includeDone, limit }) => {
        logger.log("tool", "resolve_task");
        const result = resolveTask({ query, includeDone, limit });
        if (result.type === "exact") {
          resolvedTaskIds.add(result.task.id);
        }

        return json(result);
      },
    }),
    zodTool({
      name: "update_task",
      description:
        "Update an existing task by id. Use only after the target task has been confidently resolved.",
      inputSchema: z.object({
        id: z.number().int().positive(),
        fields: updateTaskFieldsSchema,
      }),
      run: ({ id, fields }) => {
        logger.log("tool", "update_task");
        if (!resolvedTaskIds.has(id)) {
          throw new Error(
            "update_task is blocked until resolve_task returns one exact task in the current turn",
          );
        }

        return json(
          updateTask({
            id,
            fields,
            timezone: config.timezone,
            referenceInstant: new Date(
              config.referenceInstant ?? DEFAULT_REFERENCE_ISO,
            ),
          }),
        );
      },
    }),
    zodTool({
      name: "delete_task",
      description: "Delete an existing task by id after confirmation.",
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
      run: ({ id }) => {
        logger.log("tool", "delete_task");
        if (!resolvedTaskIds.has(id)) {
          throw new Error(
            "delete_task is blocked until resolve_task returns one exact task in the current turn",
          );
        }

        return json(deleteTask(id));
      },
    }),
    zodTool({
      name: "get_energy_context",
      description:
        "Return a compact summary of current energy, next peak, next dip, and next rebound for the session hour.",
      inputSchema: z.object({
        currentHour: z.number().int().min(0).max(23).optional(),
        label: z.string().optional(),
      }),
      run: async ({ currentHour, label }) => {
        logger.log("subagent", "energy");
        const result = await getEnergyContext({
          currentHour: currentHour ?? config.currentHour,
          label,
        });
        return result.summary;
      },
    }),
    zodTool({
      name: "get_task_context",
      description:
        "Return a compact summary grouping open tasks by deadline urgency and effort level.",
      inputSchema: z.object({}),
      run: async () => {
        logger.log("subagent", "tasks");
        const result = await getTaskContext({
          referenceInstant: config.referenceInstant ?? DEFAULT_REFERENCE_ISO,
        });
        return result.summary;
      },
    }),
    zodTool({
      name: "get_task_list",
      description:
        "Return a concise markdown task list grouped for display. Use this when the user wants to see their tasks.",
      inputSchema: z.object({
        status: z.enum(["todo", "in_progress", "done"]).optional(),
      }),
      run: async ({ status }) => {
        logger.log("subagent", "task-list");
        const result = await getTaskList({ status });
        return result.summary;
      },
    }),
  ];
}

function buildRequestParams(
  config: ChatSessionConfig,
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  logger: AgentLogger,
) {
  return {
    model: DEFAULT_CHAT_MODEL,
    max_tokens: 1_200,
    max_iterations: 10,
    stream: true as const,
    system: buildSystemPrompt(config),
    messages,
    tools: buildTools(config, logger),
  };
}

export async function countContextTokens(
  client: Anthropic,
  config: ChatSessionConfig,
  history: Anthropic.Beta.Messages.BetaMessageParam[],
): Promise<number> {
  const request = buildRequestParams(config, history, {
    log() {},
  });

  const result = await client.beta.messages.countTokens({
    model: request.model,
    messages: request.messages,
    system: request.system,
    tools: request.tools,
  });

  return result.input_tokens;
}

export async function runChatTurn(
  params: ChatTurnParams,
): Promise<ChatTurnResult> {
  const client = getAnthropicClient();
  const userMessage: Anthropic.Beta.Messages.BetaMessageParam = {
    role: "user",
    content: params.userInput,
  };
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    ...params.history,
    userMessage,
  ];

  const runner = client.beta.messages.toolRunner(
    buildRequestParams(params.config, messages, params.logger),
    {},
  );

  let assistantText = "";

  for await (const stream of runner) {
    stream.on("text", (delta) => {
      assistantText += delta;
    });

    await stream.done();
  }

  const finalMessage = await runner.done();
  assistantText = extractAssistantText(finalMessage) || assistantText.trim();
  const history: Anthropic.Beta.Messages.BetaMessageParam[] = [
    ...params.history,
    userMessage,
    {
      role: "assistant",
      content: finalMessage.content,
    },
  ];
  const contextTokens = await countContextTokens(client, params.config, history);

  return {
    history,
    assistantText,
    contextTokens,
  };
}

function formatLogEntry(kind: LogKind, label: string): string {
  const prefix =
    kind === "skill"
      ? "[skill"
      : kind === "subagent"
        ? "[subagent"
        : "[tool";

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
