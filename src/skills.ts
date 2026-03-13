import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export type SkillFrontmatter = {
  name: string;
  description: string;
};

export type DiscoveredSkill = SkillFrontmatter & {
  path: string;
};

export type LoadedSkill = DiscoveredSkill & {
  instructions: string;
};

const SKILL_FILE_NAME = 'SKILL.md';

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
      files.push(fullPath);
    }
  }

  return files;
}

export function stripFrontmatter(markdown: string): string {
  return matter(markdown).content.trim();
}

export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const parsed = matter(markdown);
  const data = parsed.data as Partial<SkillFrontmatter>;

  if (!data.name || !data.description) {
    throw new Error('Skill frontmatter must include name and description');
  }

  return {
    name: data.name,
    description: data.description,
  };
}

export function discoverSkills(skillsDir = path.join(process.cwd(), 'skills')): DiscoveredSkill[] {
  if (!statSync(skillsDir, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }

  return walk(skillsDir)
    .map((skillPath) => {
      const content = readFileSync(skillPath, 'utf-8');
      const frontmatter = parseSkillFrontmatter(content);

      return {
        ...frontmatter,
        path: skillPath,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function loadSkill(name: string, skillsDir = path.join(process.cwd(), 'skills')): LoadedSkill {
  const discovered = discoverSkills(skillsDir);
  const skill = discovered.find((entry) => entry.name === name);

  if (!skill) {
    throw new Error(`Skill '${name}' not found in ${skillsDir}`);
  }

  return {
    ...skill,
    instructions: stripFrontmatter(readFileSync(skill.path, 'utf-8')),
  };
}

export function buildSkillSummary(skills: DiscoveredSkill[]): string {
  const lines = [
    '## Skills',
    '',
    'Use the `load_skill` tool to load specialized instructions before acting on a task.',
    '',
    'Available skills:',
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ];

  return lines.join('\n');
}
