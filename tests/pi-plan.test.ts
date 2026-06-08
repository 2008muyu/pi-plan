/**
 * @2008muyu/pi-plan — Unit tests
 *
 * Run with: npx tsx --test tests/pi-plan.test.ts
 *
 * Tests module-level pure functions and config I/O.
 * Extension-level integration (tool calls, events) is not covered here.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── Import module-level functions from source ──────────────────────────────

import {
  PLAN_BLOCKED_TOOLS as _unused,
  resolvePlanTools,
  resolveExecTools,
  hasOutputRedirect,
  isSafeCommand,
  loadConfig,
  loadProjectConfig,
  saveProjectConfig,
  projectConfigPath,
} from '../extensions/pi-plan.ts';

// =============================================================================
//  resolvePlanTools / resolveExecTools
// =============================================================================

describe('resolvePlanTools', () => {
  it('blocks edit and write', () => {
    const tools = ['read', 'bash', 'edit', 'write', 'grep'];
    const result = resolvePlanTools(tools, []);
    assert.deepEqual(result, ['read', 'bash', 'grep']);
  });

  it('blocks exec-only tools', () => {
    const tools = ['read', 'bash', 'update_task', 'add_task', 'update_tasks', 'subagent'];
    const result = resolvePlanTools(tools, []);
    assert.deepEqual(result, ['read', 'bash', 'subagent']);
  });

  it('blocks user-configured tools', () => {
    const tools = ['read', 'bash', 'godot_create_node', 'godot_set_cell', 'edit'];
    const result = resolvePlanTools(tools, ['godot_create_node']);
    assert.deepEqual(result, ['read', 'bash', 'godot_set_cell']);
  });

  it('keeps subagent and web_search available', () => {
    const tools = ['subagent', 'web_search', 'code_search', 'fetch_content'];
    const result = resolvePlanTools(tools, []);
    assert.deepEqual(result, ['subagent', 'web_search', 'code_search', 'fetch_content']);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(resolvePlanTools([], []), []);
  });

  it('returns all if nothing to block', () => {
    const tools = ['read', 'bash', 'ls'];
    assert.deepEqual(resolvePlanTools(tools, []), ['read', 'bash', 'ls']);
  });

  it('combines built-in blocked tools with user blocked', () => {
    const tools = ['edit', 'write', 'subagent', 'web_search'];
    // edit/write blocked by built-in, subagent blocked by user
    const result = resolvePlanTools(tools, ['subagent']);
    assert.deepEqual(result, ['web_search']);
  });
});

describe('resolveExecTools', () => {
  it('returns all tools unchanged', () => {
    const tools = ['read', 'bash', 'edit', 'write', 'subagent', 'update_task'];
    assert.deepEqual(resolveExecTools(tools), tools);
  });

  it('returns a new array (not same reference)', () => {
    const tools = ['read', 'bash'];
    const result = resolveExecTools(tools);
    assert.notStrictEqual(result, tools);
    assert.deepEqual(result, tools);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(resolveExecTools([]), []);
  });
});

// =============================================================================
//  hasOutputRedirect
// =============================================================================

describe('hasOutputRedirect', () => {
  it('detects simple redirect', () => {
    assert.equal(hasOutputRedirect('echo hello > file.txt'), true);
  });

  it('detects append redirect', () => {
    assert.equal(hasOutputRedirect('echo hello >> log.txt'), true);
  });

  it('detects numeric fd redirect', () => {
    assert.equal(hasOutputRedirect('echo data 1> out.txt'), true);
  });

  it('allows /dev/null redirect', () => {
    assert.equal(hasOutputRedirect('grep foo bar.txt > /dev/null'), false);
  });

  it('allows 2>/dev/null', () => {
    assert.equal(hasOutputRedirect('grep foo bar.txt 2>/dev/null'), false);
  });

  it('allows 2>&1', () => {
    assert.equal(hasOutputRedirect('grep foo bar.txt 2>&1'), false);
  });

  it('allows &>/dev/null', () => {
    assert.equal(hasOutputRedirect('grep foo bar.txt &>/dev/null'), false);
  });

  it('handles no redirect', () => {
    assert.equal(hasOutputRedirect('ls -la'), false);
  });

  it('handles empty string', () => {
    assert.equal(hasOutputRedirect(''), false);
  });

  it('handles mixed: redirect to file despite /dev/null usage elsewhere', () => {
    // 2>/dev/null is fine, but > file.txt is not
    assert.equal(hasOutputRedirect('grep foo bar.txt 2>/dev/null > output.txt'), true);
  });

  it('detects >> to real file', () => {
    assert.equal(hasOutputRedirect('echo data >> data.txt'), true);
  });
});

// =============================================================================
//  isSafeCommand
// =============================================================================
//
// isSafeCommand() depends on loadConfig() which reads ~/.pi/agent/pi-plan.json.
// To ensure deterministic tests, we temporarily rename any existing config
// before the tests and restore it after.

const GLOBAL_CONFIG_PATH = join(homedir(), '.pi', 'agent', 'pi-plan.json');

let hadRealConfig = false;

function saveRealConfig() {
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    hadRealConfig = true;
    const backup = GLOBAL_CONFIG_PATH + '.test-backup';
    if (!existsSync(backup)) {
      // Only backup if not already backed up (parallel test safety)
      renameSync(GLOBAL_CONFIG_PATH, backup);
    }
  }
}

function restoreRealConfig() {
  if (hadRealConfig) {
    const backup = GLOBAL_CONFIG_PATH + '.test-backup';
    if (existsSync(backup)) {
      renameSync(backup, GLOBAL_CONFIG_PATH);
    }
  }
}

describe('isSafeCommand (blacklist mode)', () => {
  before(() => { saveRealConfig(); });
  after(() => { restoreRealConfig(); });

  it('allows read-only commands', () => {
    assert.equal(isSafeCommand('ls -la'), true);
    assert.equal(isSafeCommand('grep foo bar.txt'), true);
    assert.equal(isSafeCommand('cat file.txt'), true);
    assert.equal(isSafeCommand('git status'), true);
    assert.equal(isSafeCommand('node -e "console.log(1)"'), true);
  });

  it('blocks known unsafe commands in blacklist mode', () => {
    assert.equal(isSafeCommand('rm -rf /'), false);
    assert.equal(isSafeCommand('mv old.txt new.txt'), false);
    assert.equal(isSafeCommand('cp a.txt b.txt'), false);
    assert.equal(isSafeCommand('chmod +x script.sh'), false);
    assert.equal(isSafeCommand('npm install express'), false);
  });

  it('allows safe npm subcommands', () => {
    assert.equal(isSafeCommand('npm list'), true);
    assert.equal(isSafeCommand('npm outdated'), true);
  });

  it('handles empty command', () => {
    assert.equal(isSafeCommand(''), true);
    assert.equal(isSafeCommand('   '), true);
  });

  it('blocks curl with -O or -o', () => {
    assert.equal(isSafeCommand('curl -O https://example.com/file'), false);
    assert.equal(isSafeCommand('curl -o file https://example.com/file'), false);
    assert.equal(isSafeCommand('curl https://example.com'), true); // no output flag
  });

  it('blocks pip install', () => {
    assert.equal(isSafeCommand('pip install requests'), false);
    assert.equal(isSafeCommand('pip3 install requests'), false);
  });
});

// =============================================================================
//  loadProjectConfig / saveProjectConfig
// =============================================================================

describe('loadProjectConfig', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), 'pi-plan-test-' + randomUUID());
    mkdirSync(join(tmpDir, '.pi'), { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default config when file does not exist', () => {
    const cfg = loadProjectConfig(tmpDir);
    assert.deepEqual(cfg, { planBlockedTools: [] });
  });

  it('reads custom planBlockedTools from .pi/pi-plan.json', () => {
    const tools = ['godot_create_node', 'godot_set_cell'];
    const cfgPath = join(tmpDir, '.pi', 'pi-plan.json');
    writeFileSync(cfgPath, JSON.stringify({ planBlockedTools: tools }), 'utf8');
    const cfg = loadProjectConfig(tmpDir);
    assert.deepEqual(cfg, { planBlockedTools: tools });
  });

  it('handles empty .pi/pi-plan.json gracefully', () => {
    const cfgPath = join(tmpDir, '.pi', 'pi-plan.json');
    writeFileSync(cfgPath, '{}', 'utf8');
    const cfg = loadProjectConfig(tmpDir);
    assert.deepEqual(cfg, { planBlockedTools: [] });
  });

  it('returns defaults for corrupted .pi/pi-plan.json', () => {
    const cfgPath = join(tmpDir, '.pi', 'pi-plan.json');
    writeFileSync(cfgPath, '{invalid json}', 'utf8');
    const cfg = loadProjectConfig(tmpDir);
    assert.deepEqual(cfg, { planBlockedTools: [] });
  });
});

describe('saveProjectConfig', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), 'pi-plan-test-' + randomUUID());
    mkdirSync(join(tmpDir, '.pi'), { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads back project config', () => {
    const expected = { planBlockedTools: ['godot_create_node'] };
    saveProjectConfig(tmpDir, expected);
    const cfg = loadProjectConfig(tmpDir);
    assert.deepEqual(cfg, expected);
  });

  it('overwrites existing config', () => {
    saveProjectConfig(tmpDir, { planBlockedTools: ['tool_a'] });
    saveProjectConfig(tmpDir, { planBlockedTools: ['tool_b'] });
    const cfg = loadProjectConfig(tmpDir);
    assert.deepEqual(cfg, { planBlockedTools: ['tool_b'] });
  });

  it('creates .pi directory if missing', () => {
    const cleanDir = join(tmpdir(), 'pi-plan-test-' + randomUUID());
    saveProjectConfig(cleanDir, { planBlockedTools: ['test'] });
    assert.equal(existsSync(join(cleanDir, '.pi', 'pi-plan.json')), true);
    rmSync(cleanDir, { recursive: true, force: true });
  });

  it('writes empty planBlockedTools', () => {
    saveProjectConfig(tmpDir, { planBlockedTools: [] });
    const cfg = loadProjectConfig(tmpDir);
    assert.deepEqual(cfg, { planBlockedTools: [] });
  });
});

describe('projectConfigPath', () => {
  it('returns correct path', () => {
    const cwd = '/some/project';
    const result = projectConfigPath(cwd);
    // On Unix: '/some/project/.pi/pi-plan.json'
    // On Windows: '\some\project\.pi\pi-plan.json'
    const expected = join(cwd, '.pi', 'pi-plan.json');
    assert.equal(result, expected);
  });

  it('handles Windows-style paths', () => {
    const cwd = 'C:\\Users\\test\\project';
    const result = projectConfigPath(cwd);
    assert.equal(result, 'C:\\Users\\test\\project\\.pi\\pi-plan.json');
  });
});

// =============================================================================
//  Plan manifest operations (simulating lifecycle/clean/list logic)
// =============================================================================

describe('plan manifest operations', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = join(tmpdir(), 'pi-plan-test-' + randomUUID());
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, '.plans', 'plan-a'), { recursive: true });
    mkdirSync(join(tmpDir, '.plans', 'plan-b'), { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePlanFilesFake(name: string, taskCount: number, status: string): void {
    const manifestPath = join(tmpDir, '.plans', 'plans.jsonl');
    const existing = existsSync(manifestPath)
      ? readFileSync(manifestPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    const existingPlan = existing.find((p: any) => p.name === name);
    const entry = { name, title: `Plan ${name}`, status, created_at: new Date().toISOString() };
    if (existingPlan) Object.assign(existingPlan, entry);
    else existing.push(entry);
    writeFileSync(manifestPath, existing.map((r: any) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    // Create tasks.jsonl
    const tasksPath = join(tmpDir, '.plans', name, 'tasks.jsonl');
    mkdirSync(dirname(tasksPath), { recursive: true });
    const meta = { _type: 'meta', title: `Plan ${name}`, plan_name: name, created_at: new Date().toISOString() };
    const tasks = Array.from({ length: taskCount }, (_, i) => ({
      id: `t-${String(i + 1).padStart(3, '0')}`,
      description: `Task ${i + 1}`,
      status: status === 'done' ? 'done' : 'pending',
      origin: 'plan',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    writeFileSync(tasksPath, [JSON.stringify(meta), ...tasks.map(t => JSON.stringify(t))].join('\n') + '\n', 'utf8');
  }

  it('writes and reads plan manifest', () => {
    writePlanFilesFake('plan-a', 3, 'in-progress');
    const manifestPath = join(tmpDir, '.plans', 'plans.jsonl');
    const entries = readFileSync(manifestPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'plan-a');
    assert.equal(entries[0].status, 'in-progress');
  });

  it('updates existing plan status', () => {
    writePlanFilesFake('plan-a', 3, 'done');
    const manifestPath = join(tmpDir, '.plans', 'plans.jsonl');
    const entries = readFileSync(manifestPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const planA = entries.find((e: any) => e.name === 'plan-a');
    assert.equal(planA.status, 'done');
  });

  it('supersedes old plan when new one is created', () => {
    writePlanFilesFake('plan-a', 3, 'in-progress');
    writePlanFilesFake('plan-b', 5, 'in-progress');
    const manifestPath = join(tmpDir, '.plans', 'plans.jsonl');
    const entries = readFileSync(manifestPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const planA = entries.find((e: any) => e.name === 'plan-a');
    const planB = entries.find((e: any) => e.name === 'plan-b');
    // When plan-b is created while plan-a is in-progress, plan-a should be superseded
    // (This simulates the writePlanFiles logic)
    assert.equal(planA.status, 'in-progress'); // initial
    // Now simulate the supersede logic from writePlanFiles
    for (const p of entries) {
      if (p.name !== 'plan-b' && p.status === 'in-progress') {
        p.status = 'superseded';
      }
    }
    writeFileSync(manifestPath, entries.map((r: any) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const updatedPlanA = entries.find((e: any) => e.name === 'plan-a');
    assert.equal(updatedPlanA.status, 'superseded');
    assert.equal(planB.status, 'in-progress');
  });

  it('deletes plan from manifest and directory', () => {
    writePlanFilesFake('plan-a', 2, 'done');
    const dir = join(tmpDir, '.plans', 'plan-a');
    const manifestPath = join(tmpDir, '.plans', 'plans.jsonl');

    // Simulate delete (same as /plan clean and list Delete action)
    assert.equal(existsSync(dir), true);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);

    const entries = existsSync(manifestPath)
      ? readFileSync(manifestPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    const filtered = entries.filter((e: any) => e.name !== 'plan-a');
    writeFileSync(manifestPath, filtered.map((r: any) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const after = readFileSync(manifestPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(after.find((e: any) => e.name === 'plan-a'), undefined);
  });

  it('filters deletable plans (done/superseded/abandoned)', () => {
    // Create a mix of plans
    const testDir = join(tmpdir(), 'pi-plan-test-' + randomUUID());
    mkdirSync(testDir, { recursive: true });

    const manifestPath = join(testDir, '.plans', 'plans.jsonl');
    mkdirSync(join(testDir, '.plans'), { recursive: true });
    const entries = [
      { name: 'p1', title: 'Plan 1', status: 'done', created_at: new Date().toISOString() },
      { name: 'p2', title: 'Plan 2', status: 'in-progress', created_at: new Date().toISOString() },
      { name: 'p3', title: 'Plan 3', status: 'superseded', created_at: new Date().toISOString() },
      { name: 'p4', title: 'Plan 4', status: 'abandoned', created_at: new Date().toISOString() },
    ];
    writeFileSync(manifestPath, entries.map((r: any) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const deletable = entries.filter(e => e.status === 'done' || e.status === 'superseded' || e.status === 'abandoned');
    assert.equal(deletable.length, 3); // p1, p3, p4
    assert.equal(deletable.find((e: any) => e.name === 'p2'), undefined); // in-progress not deletable

    rmSync(testDir, { recursive: true, force: true });
  });

  it('counts done/skipped tasks per plan', () => {
    writePlanFilesFake('plan-a', 3, 'done');
    // Override tasks to mix statuses
    const tasksPath = join(tmpDir, '.plans', 'plan-a', 'tasks.jsonl');
    const meta = { _type: 'meta', title: 'Plan A', plan_name: 'plan-a', created_at: new Date().toISOString() };
    const tasks = [
      { id: 't-001', description: 'Task 1', status: 'done', origin: 'plan', created_at: '', updated_at: '' },
      { id: 't-002', description: 'Task 2', status: 'skipped', origin: 'plan', created_at: '', updated_at: '' },
      { id: 't-003', description: 'Task 3', status: 'blocked', origin: 'plan', created_at: '', updated_at: '' },
    ];
    writeFileSync(tasksPath, [JSON.stringify(meta), ...tasks.map(t => JSON.stringify(t))].join('\n') + '\n', 'utf8');

    const rows = readFileSync(tasksPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const taskRows = rows.filter((r: any) => r._type !== 'meta');
    assert.equal(taskRows.length, 3);
    const done = taskRows.filter((t: any) => t.status === 'done' || t.status === 'skipped').length;
    assert.equal(done, 2); // t-001 done, t-002 skipped
    const blocked = taskRows.filter((t: any) => t.status === 'blocked').length;
    assert.equal(blocked, 1); // t-003 blocked
  });
});
