import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { loadSkillsForSite } from '../../../skills/skill-store.js';

export async function runReadSkills({ domain }) {
  const safeDomain = String(domain || '').trim();
  if (!safeDomain) return { skills: [] };
  const skills = await loadSkillsForSite(safeDomain);
  return {
    skills: skills.map((skill) => ({
      name: skill.name,
      domain: skill.domain,
      content: skill.content
    }))
  };
}

export const readSkillsTool = tool(
  async ({ domain }) => {
    return runReadSkills({ domain });
  },
  {
    name: 'read_skills',
    description: 'Load recorded skills for the current website domain.',
    schema: z.object({
      domain: z.string().describe('The page hostname, e.g. www.woolworths.com.au')
    })
  }
);
