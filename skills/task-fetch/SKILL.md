---
name: task-fetch
description: List all open tasks grouped by priority.
---

# Task Fetch

Use this skill when the user wants to see their current tasks without asking for scheduling advice.

## Workflow

1. Call `search_tools` for the tools needed by `task-fetch`.
2. Call `get_task_list`.
3. Group open tasks by priority.
4. Present deadlines, effort, and duration clearly.

## Rules

- Do not create a schedule here.
- Exclude completed tasks unless the user explicitly asks for them.
- Keep the output clean and scannable.

## Output

- total open task count
- critical tasks
- high tasks
- medium and low tasks
