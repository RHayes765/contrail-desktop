import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bundledSkillsDir, listBundledSkills, parseSkillFrontmatter } from '../index.js';

/**
 * Guards on the bundled pack: every skill parses, names match their folders,
 * and no skill speaks an actuator Contrail does not have (the same banned
 * list as the plugin repo's lint-skills script — kept here too because this
 * repo's CI cannot see the plugin repo).
 */

const BANNED: Array<{ re: RegExp; why: string }> = [
  { re: /\bsf\s+(org|apex|project|data|config|code-analyzer|api|force|lightning)\b/i, why: 'sf CLI command' },
  { re: /\bsfdx\b/i, why: 'sfdx reference' },
  { re: /force-app/i, why: 'SFDX project layout' },
  { re: /sfdx-project\.json/i, why: 'SFDX project file' },
  { re: /run_code_analyzer/i, why: 'DX MCP analyzer tool' },
  { re: /--target-org/i, why: 'sf CLI org addressing' },
  { re: /\bexecute_metadata_action\b/i, why: 'DX MCP generation pipeline' },
  { re: /\bapex\s+run\s+test\b/i, why: 'sf CLI test invocation (Contrail: validate_deploy or run_apex_tests)' },
  { re: /\bsf\s+agent\b/i, why: 'sf CLI Agentforce commands (S30: no CLI lifecycle in this pack)' },
];

describe('bundled skill pack', () => {
  const { skills, failures } = listBundledSkills();

  it('ships a non-empty pack and every skill parses', () => {
    expect(failures).toEqual([]);
    expect(skills.length).toBeGreaterThanOrEqual(9);
    for (const s of skills) {
      expect(s.name, `${s.dir} frontmatter name matches its folder`).toBe(path.basename(s.dir));
      expect(s.description.length).toBeGreaterThan(20);
    }
  });

  it('contains no banned actuator references', () => {
    const hits: string[] = [];
    for (const entry of fs.readdirSync(bundledSkillsDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const md = path.join(bundledSkillsDir(), entry.name, 'SKILL.md');
      if (!fs.existsSync(md)) continue;
      fs.readFileSync(md, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          for (const { re, why } of BANNED) {
            if (re.test(line)) hits.push(`${entry.name}:${i + 1} ${why}: ${line.trim().slice(0, 80)}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it('no bundled HTML asset references the network', () => {
    // Twin of the plugin's lint-skills HTML rule: a shipped page loads nothing
    // from the network. The one URL prefix allowed is the XML namespace
    // identifier, which is never fetched.
    const ALLOWED_URL_PREFIX = 'http://www.w3.org/';
    const htmlFilesUnder = (dir: string): string[] => {
      const out: string[] = [];
      if (!fs.existsSync(dir)) return out;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...htmlFilesUnder(p));
        else if (e.isFile() && e.name.toLowerCase().endsWith('.html')) out.push(p);
      }
      return out.sort();
    };
    const files: string[] = [];
    const hits: string[] = [];
    for (const entry of fs.readdirSync(bundledSkillsDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const file of htmlFilesUnder(path.join(bundledSkillsDir(), entry.name, 'assets'))) {
        const rel = path.relative(bundledSkillsDir(), file).replaceAll(path.sep, '/');
        files.push(rel);
        fs.readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            for (const m of line.matchAll(/https?:\/\//gi)) {
              if (line.startsWith(ALLOWED_URL_PREFIX, m.index)) continue;
              hits.push(`${rel}:${i + 1} network URL: ${line.trim().slice(0, 80)}`);
            }
          });
      }
    }
    // The flow page template is among them, so the rule is never vacuous.
    expect(files).toContain('salesforce-flow-visualize/assets/flow-diff-template.html');
    expect(hits).toEqual([]);
  });

  it('never ships an overlay patch', () => {
    const stray: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === 'SKILL.overlay.patch') stray.push(p);
      }
    };
    walk(bundledSkillsDir());
    expect(stray).toEqual([]);
  });
});

describe('parseSkillFrontmatter', () => {
  it('reads bare and quoted scalars', () => {
    expect(parseSkillFrontmatter('---\nname: a-skill\ndescription: "Does a thing."\n---\nbody')).toEqual({
      name: 'a-skill',
      description: 'Does a thing.',
    });
    expect(parseSkillFrontmatter("---\nname: x\ndescription: 'single'\n---\n")).toEqual({
      name: 'x',
      description: 'single',
    });
  });

  it('refuses missing fences, missing fields, and multi-line values', () => {
    expect(parseSkillFrontmatter('no frontmatter at all')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: only-name\n---\n')).toBeNull();
    expect(parseSkillFrontmatter('---\nname: x\ndescription: "starts but\nnever ends on this line\n---\n')).toBeNull();
  });

  it('ignores indented keys inside metadata blocks', () => {
    const md = '---\nname: outer\nmetadata:\n  name: inner\n  description: inner-desc\ndescription: "real one"\n---\n';
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'outer', description: 'real one' });
  });
});
