---
name: task-create
description: Extract task details from natural language input and insert a new task.
---

# Task Create

Use this skill when the user is creating a new task from natural language.

## Goals

- Extract the task title clearly.
- Infer or confirm missing task fields.
- Normalize any deadline text before insertion.
- Return a concise confirmation with the final stored values.

## Required Fields

- `title`
- `effort`
- `priority`
- `duration_minutes`

## Optional Fields

- `deadline_raw`
- `category`

## Inference Rules

- If effort is not stated, infer it from the task scope and wording.
- If priority is not stated, infer urgency from the user's wording and deadline.
- If duration is not stated, estimate a realistic duration in minutes.
- If the deadline is vague, preserve the user's original wording and use the parser output.

## Workflow

1. Understand the user request and extract the task intent.
2. Call `search_tools` for the tools needed by `task-create`.
3. Load current task and energy context if it helps place the task in the day.
4. Call `create_task` with the parsed fields.
5. Confirm the created task using the normalized values returned by the tool.

## Output

Return a short confirmation that includes:

- title
- effort
- priority
- duration
- deadline if present
- category if present
