---
name: energy-check
description: Summarise the user's current energy level and upcoming windows.
---

# Energy Check

Use this skill when the user asks about their current energy, next peak, next dip, or what kind of work fits right now.

## Workflow

1. Determine the current hour.
2. Call `get_energy_context`.
3. Summarise the user's current level and what comes next.
4. Give a one-line recommendation for the kind of work that fits now.

## Output

- current energy level
- next peak
- next dip
- next rebound
- best type of work right now

## Rules

- Keep the answer practical.
- Use plain language.
- Avoid listing tasks unless the user explicitly asks for task guidance.
