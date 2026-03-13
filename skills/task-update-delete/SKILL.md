---
name: task-update-delete
description: Find, confirm, and update or delete an existing task.
---

# Task Update Delete

Use this skill when the user wants to modify, complete, remove, or cancel a task.

## Rules

- Never mutate a task before resolving the intended row.
- Always use `resolve_task` first for natural-language references.
- If multiple tasks match, ask a short clarification question.
- Never delete without confirming the exact task.
- `update_task` and `delete_task` are guarded: they only work after `resolve_task` returns one exact task in the current turn.

## Workflow

1. Call `search_tools` for the tools needed by `task-update-delete`.
2. Resolve the task reference from the user's wording.
3. If there is one confident match, continue.
4. If there are multiple candidates, stop and ask which one.
5. Call `update_task` or `delete_task`.
6. Confirm the final result briefly.

## Update Guidance

- For status changes to `done`, preserve the rest of the record unless the user asked for more.
- For effort or deadline changes, consider loading task or energy context if it affects planning.
- For delete requests, keep the response factual and explicit about what was removed.

## Output

- For updates: state the task name and the fields changed.
- For deletions: state the task name and that it was removed.
- For ambiguity: list only the minimal candidate set needed for clarification.
