import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type SkillInfo = {
  name: string;
  description: string;
  dir: string;
};

const skillsRoot = path.join(homedir(), '.claude', 'skills');

let cachedSkills: SkillInfo[] | null = null;
let pendingSkillsLoad: Promise<SkillInfo[]> | null = null;

function cleanFrontmatterValue(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

export function parseSkillFrontmatter(markdown: string): Pick<SkillInfo, 'name' | 'description'> | null {
  const sections = markdown.split('---');
  if (sections.length < 3) {
    return null;
  }

  const frontmatter = sections[1] ?? '';
  const nameMatch = frontmatter.match(/^\s*name:\s*(.+)\s*$/m);
  const descriptionMatch = frontmatter.match(/^\s*description:\s*(.+)\s*$/m);

  const name = nameMatch ? cleanFrontmatterValue(nameMatch[1]) : '';
  const description = descriptionMatch ? cleanFrontmatterValue(descriptionMatch[1]) : '';

  if (!name || !description) {
    return null;
  }

  return { name, description };
}

export async function readSkillsFromDirectory(rootDir: string): Promise<SkillInfo[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const skills = await Promise.all(entries.map(async (entry) => {
    const dir = path.join(rootDir, entry.name);

    // Follow symlinks — most skills are symlinked
    try {
      const stats = await stat(dir);
      if (!stats.isDirectory()) return null;
    } catch {
      return null;
    }

    const skillFile = path.join(dir, 'SKILL.md');

    try {
      const markdown = await readFile(skillFile, 'utf8');
      const metadata = parseSkillFrontmatter(markdown);
      if (!metadata) {
        return null;
      }

      return {
        ...metadata,
        dir,
      } satisfies SkillInfo;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw error;
    }
  }));

  return skills
    .filter((skill): skill is SkillInfo => skill !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function loadSkills(rootDir: string): Promise<SkillInfo[]> {
  try {
    const skills = await readSkillsFromDirectory(rootDir);
    cachedSkills = skills;
    return skills;
  } finally {
    pendingSkillsLoad = null;
  }
}

export async function listSkills(): Promise<SkillInfo[]> {
  if (cachedSkills) {
    return cachedSkills;
  }

  if (!pendingSkillsLoad) {
    pendingSkillsLoad = loadSkills(skillsRoot);
  }

  return pendingSkillsLoad;
}

export async function refreshSkills(): Promise<SkillInfo[]> {
  pendingSkillsLoad = loadSkills(skillsRoot);
  return pendingSkillsLoad;
}
