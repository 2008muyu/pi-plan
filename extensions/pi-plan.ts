/**
 * @2008muyu/pi-plan — 可配置双阶段规划扩展
 *
 * Plan with a strong model, execute with a light model.
 * Models are fully configurable via /plan-settings.
 *
 * 核心流程:
 *   /plan → 只读规划(强模型) → submit_plan → 执行(轻模型) → update_task
 *
 * 参考:
 *   - @dreki-gg/pi-plan-mode (phase-transitions.ts / prompts.ts)
 *   - pi 官方 examples/extensions/plan-mode
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getKeybindings, Key, matchesKey } from '@earendil-works/pi-tui';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

// ── Types ───────────────────────────────────────────────────────────────────

type TaskStatus = 'pending' | 'done' | 'skipped' | 'blocked' | 'deferred';
type PlanStatus = 'in-progress' | 'done' | 'superseded' | 'abandoned';

interface TaskRecord {
  id: string;
  description: string;
  details?: string;
  status: TaskStatus;
  depends_on?: string[];
  notes?: string;
  origin?: 'plan' | 'discovered';
  created_at: string;
  updated_at: string;
}

interface PlanMeta {
  title: string;
  plan_name: string;
  created_at: string;
}

interface PlanData {
  title: string;
  planName: string;
  handoff: string;
  tasks: TaskRecord[];
}

interface PlanConfig {
  planProvider: string;
  planModel: string;
  planThinking: string;
  execProvider: string;
  execModel: string;
  execThinking: string;
  bashSafetyMode: 'blacklist' | 'allowlist';
}

/** Project-level overrides (only tool blocking for now). */
interface ProjectConfig {
  planBlockedTools?: string[];  // tools to block in plan mode (e.g. ['godot_create_node'])
}

// ── Config ──────────────────────────────────────────────────────────────────
//
// Global config:  ~/.pi/agent/pi-plan.json     — models, thinking, bash mode
// Project config: .pi/pi-plan.json             — planBlockedTools (project-specific)
//
// Merge: DEFAULT → global → project (project overrides global)

const GLOBAL_CONFIG_PATH = join(homedir(), '.pi', 'agent', 'pi-plan.json');
const PROJECT_CONFIG_DIR = '.pi';
const PROJECT_CONFIG_FILE = 'pi-plan.json';

const DEFAULT_CONFIG: PlanConfig = {
  planProvider: 'anthropic',
  planModel: 'claude-opus-4-6',
  planThinking: 'medium',
  execProvider: 'openai',
  execModel: 'gpt-5.5',
  execThinking: 'low',
  bashSafetyMode: 'blacklist',
};

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  planBlockedTools: [],
};

export function loadConfig(): PlanConfig {
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) }; } catch { /* fall through */ }
  }
  return {
    planProvider: process.env.PI_PLAN_PROVIDER || DEFAULT_CONFIG.planProvider,
    planModel: process.env.PI_PLAN_MODEL || DEFAULT_CONFIG.planModel,
    planThinking: process.env.PI_PLAN_THINKING || DEFAULT_CONFIG.planThinking,
    execProvider: process.env.PI_EXEC_PROVIDER || DEFAULT_CONFIG.execProvider,
    execModel: process.env.PI_EXEC_MODEL || DEFAULT_CONFIG.execModel,
    execThinking: process.env.PI_EXEC_THINKING || DEFAULT_CONFIG.execThinking,
    bashSafetyMode: (process.env.PI_PLAN_BASH_SAFETY_MODE as any) || DEFAULT_CONFIG.bashSafetyMode,
  };
}

export function saveConfig(cfg: PlanConfig): void {
  mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
}

export function loadProjectConfig(cwd: string): ProjectConfig {
  const p = projectConfigPath(cwd);
  if (existsSync(p)) {
    try { return { ...DEFAULT_PROJECT_CONFIG, ...JSON.parse(readFileSync(p, 'utf8')) }; } catch { /* fall through */ }
  }
  return { ...DEFAULT_PROJECT_CONFIG };
}

export function saveProjectConfig(cwd: string, cfg: ProjectConfig): void {
  const dir = join(cwd, PROJECT_CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(projectConfigPath(cwd), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// ── File I/O helpers ────────────────────────────────────────────────────────

const PLANS_ROOT = '.plans';

function planDir(name: string): string { return join(PLANS_ROOT, name); }

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function writeJsonl<T>(file: string, rows: T[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// ── Bash safety ─────────────────────────────────────────────────────────────

const SAFE_COMMANDS = [
  /^cat\b/, /^head\b/, /^tail\b/, /^less\b/, /^more\b/,
  /^grep\b/, /^rg\b/, /^find\b/, /^fd\b/,
  /^ls\b/, /^pwd\b/, /^tree\b/, /^which\b/, /^type\b/,
  /^git\s+(status|log|diff|branch|show|stash\s+list)\b/,
  /^npm\s+(list|outdated|view)\b/, /^node\s+-e\b/,
  /^uname\b/, /^whoami\b/, /^date\b/, /^uptime\b/,
  /^echo\b/, /^printf\b/, /^env\b/, /^printenv\b/,
  /^--help\b/, /^-h\b/, /^--version\b/, /^man\b/,
  /^dir\b/, /^type\b/, /^help\b/,
  // Read-only POSIX utilities
  /^sed\b/, /^awk\b/, /^sort\b/, /^uniq\b/,
  /^wc\b/, /^cut\b/, /^tr\b/, /^file\b/,
  /^stat\b/, /^du\b/, /^df\b/, /^diff\b/,
  /^comm\b/, /^paste\b/, /^column\b/, /^xargs\b/,
  /^basename\b/, /^dirname\b/, /^realpath\b/, /^readlink\b/,
  /^fmt\b/, /^nl\b/, /^od\b/, /^fold\b/,
  // Read-only npm/CLI tools
  /^defuddle\b/,
];

/** Commands that write to disk — blocked in blacklist mode */
const UNSAFE_COMMANDS = [
  /^rm\b/, /^rmdir\b/, /^mv\b/, /^cp\b/,
  /^dd\b/, /^chmod\b/, /^chown\b/, /^chattr\b/, /^ln\b/,
  /^npm\s+(install|ci|add|uninstall)\b/, /^yarn\s+(add|remove|install)\b/,
  /^pnpm\s+(add|remove|install)\b/, /^bun\s+(add|remove|install)\b/,
  /^pip\b/, /^pip3\b/, /^gem\s+install\b/, /^cargo\s+install\b/,
  /^tee\b/, /^truncate\b/, /^mkfs\b/, /^fdisk\b/,
  /^wget\s+-[^O]*[Oo]/, /^curl\s+-[^\s]*[Oo]\b/,
];

function getBashSafetyMode(): 'blacklist' | 'allowlist' {
  return loadConfig().bashSafetyMode;
}

/** Check if a bash command is safe in plan mode */
export function isSafeCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return true;
  const mode = getBashSafetyMode();
  if (mode === 'allowlist') {
    return SAFE_COMMANDS.some(re => re.test(trimmed));
  }
  // Blacklist mode: allow unless explicitly unsafe
  return !UNSAFE_COMMANDS.some(re => re.test(trimmed));
}

/** Check for shell output redirection that writes to a real file.
 *  Safe patterns like 2>/dev/null, 2>&1, >/dev/null are excluded. */
export function hasOutputRedirect(cmd: string): boolean {
  // Strip safe redirect patterns (discard to /dev/null, fd merging)
  const stripped = cmd
    .replace(/\d*>\s*\/dev\/null/g, '')   // >/dev/null, 2>/dev/null
    .replace(/\d*>>\s*\/dev\/null/g, '')  // >>/dev/null, 2>>/dev/null
    .replace(/\d*>&\d/g, '')              // 2>&1, 1>&2
    .replace(/&>\s*\/dev\/null/g, '');    // &>/dev/null
  // If any > remains, it's writing to a real file
  return /(?:^|\s|[0-9&])>/.test(stripped);
}

export function isPlanPath(filePath: string): boolean {
  return filePath.startsWith(PLANS_ROOT) || filePath.startsWith('.plans\\');
}

// ── Plan tool resolution (pure functions, module-level for testability) ─────

export const PLAN_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  'edit', 'write',               // file mutation
  'update_task', 'update_tasks', // exec-only: mark tasks done/skipped/blocked
  'add_task',                    // exec-only: capture discovered follow-up
  'set_active_plan', 'update_plan', // exec-only: plan lifecycle management
]);

export function resolvePlanTools(allToolNames: string[], projectBlocked: string[]): string[] {
  const blocked = new Set([...PLAN_BLOCKED_TOOLS, ...projectBlocked]);
  return allToolNames.filter(n => !blocked.has(n));
}

export function resolveExecTools(allToolNames: string[]): string[] {
  return [...allToolNames];
}

// ── Plugin system prompts ───────────────────────────────────────────────────

function buildPlanModePrompt(tools: string[]): string {
  return `[PLAN MODE ACTIVE]
You are in conversational plan mode — a planning dialogue with strict bash restrictions.

Restrictions:
- Available tools: ${tools.join(', ')}
- Bash is restricted to read-only commands (ls, grep, git status, etc.) and info commands (--help, -h, --version, man)
- The write tool is restricted to .plans/ directory only — no codebase file creation or modification
- Do NOT make code changes during planning.

Your job is to reach shared understanding before formalizing a plan:
1. Understand the user's intent through dialogue. Push back on weak assumptions, name trade-offs, and ask clarifying questions when needed.
2. Investigate the codebase with read-only tools. Use questionnaire when explicit choices are needed.
3. Maintain a living .plans/<plan-name>/context.md as you converge.
4. Only call submit_plan after the user and agent have converged on the approach.

When you are ready to finalize the plan, call submit_plan with:
- name: a short kebab-case name (e.g. "add-auth-middleware")
- title: a human-readable plan title
- handoff: a markdown document that explains what is changing, why it matters, approach, decisions, file paths, APIs, patterns, constraints, and gotchas
- tasks: an array of tasks with id (e.g. "t-001"), description (≤60 chars), optional details, and optional depends_on task IDs`;
}

function buildExecutionPrompt(plan: PlanData, remaining: TaskRecord[]): string | undefined {
  if (remaining.length === 0) return undefined;

  const taskList = remaining.map(t => {
    const line = `${t.id}. ${t.description}`;
    return t.details ? `${line}\n   Details: ${t.details}` : line;
  }).join('\n\n');

  const current = remaining[0];
  const currentDetails = current.details ? `\nDetails: ${current.details}` : '';

  return `[EXECUTING PLAN — FOLLOW THE PLAN EXACTLY]

You are executing a structured plan. Your ONLY job is to implement the plan tasks below, one at a time.

Rules:
- Work on ONE task at a time, starting with ${current.id}
- After completing each task, IMMEDIATELY call update_task to mark it done with notes
- Do NOT run diagnostics, linters, test suites, or skills unless a task explicitly asks for it
- Do NOT explore the codebase beyond what the current task requires
- Do NOT deviate from the plan — if something seems wrong, call update_task with status "blocked"
- If you notice worthwhile work OUTSIDE the plan, call add_task to capture it, then keep going

## Current task
${current.id}: ${current.description}${currentDetails}

## Handoff
${plan.handoff}

## All remaining tasks
${taskList}

Start with ${current.id} NOW.`;
}

// ── Main extension ──────────────────────────────────────────────────────────

export default function piPlan(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let executing = false;
  let activePlanDir: string | undefined;
  let plan: PlanData | undefined;
  let executionStartIdx: number | undefined;
  let previousModel: { provider: string; id: string } | undefined;
  let previousThinking: string | undefined;

  // Tools blocked in plan mode.
  // - edit/write: file mutation (blocked by pi-plan, allowed in .plans/ via tool_call interceptor)
  // - exec-only tools: only meaningful during execution phase
  // Everything else is auto-discovered from pi.getAllTools() at runtime,
  // so pi-plan never hardcodes external extension tool names (subagent, team, web_search, etc.).
  function resolvePlanToolsForCtx(): string[] {
    const allToolNames = pi.getAllTools().map(t => t.name);
    const projCfg = loadProjectConfig(process.cwd());
    return resolvePlanTools(allToolNames, projCfg.planBlockedTools || []);
  }

  function resolveExecToolsForCtx(): string[] {
    return resolveExecTools(pi.getAllTools().map(t => t.name));
  }

  // ── State persistence ──────────────────────────────────────────────────────

  function persistState(): void {
    pi.appendEntry('pi-plan', { planDir: activePlanDir, planEnabled: planModeEnabled, executing, plan, executionStartIdx } as any);
  }

  // ── Below-editor indicator ────────────────────────────────────────────────
  //
  // Renders a colored banner below the input box so the user always knows
  // whether they're in plan mode, execution mode, or neither.
  //
  // Coloring strategy:
  //   - Plan mode   → purple (raw ANSI 141 = bright magenta/violet)
  //   - Execution   → blue   (raw ANSI 75  = bright steel blue)
  //   - Tool name   → theme accent (theme-aware)
  //   - Muted text  → theme muted
  // Falls back gracefully if the terminal doesn't support 256-color (raw
  // escapes are simply ignored on most terms; on no-color terms they're stripped).
  const PURPLE = '\x1b[1;38;5;141m';
  const BLUE   = '\x1b[1;38;5;75m';
  const RESET  = '\x1b[0m';

  function updatePlanIndicator(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const t = ctx.ui.theme;
    let line: string | undefined;

    if (planModeEnabled) {
      const head = `${PURPLE}🧭 PLAN MODE${RESET}`;
      const tail = t.fg('muted', ' · read-only tools · strong model · /plan to exit');
      line = `${head}  ${tail}`;
    } else if (executing && plan) {
      const done = plan.tasks.filter(x => x.status === 'done' || x.status === 'skipped').length;
      const total = plan.tasks.length;
      const blocked = plan.tasks.filter(x => x.status === 'blocked').length;
      const head = `${BLUE}⚙ EXECUTING${RESET}`;
      const title = t.fg('accent', `“${plan.title}”`);
      const progress = t.fg('muted', `${done}/${total} tasks`);
      const blockedTag = blocked > 0 ? '  ' + t.fg('error', `✗ ${blocked} blocked`) : '';
      line = `${head}  ${title}  ${progress}${blockedTag}  ${t.fg('muted', '· /plan to abort')}`;
    }

    if (line) ctx.ui.setWidget('pi-plan-indicator', [line], { placement: 'belowEditor' });
    else      ctx.ui.setWidget('pi-plan-indicator', undefined);
  }

  function restoreState(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: any }>;
    const saved = entries.filter(e => e.type === 'custom' && e.customType === 'pi-plan').pop();
    if (saved?.data) {
      planModeEnabled = saved.data.planEnabled ?? false;
      executing = saved.data.executing ?? false;
      activePlanDir = saved.data.planDir;
      plan = saved.data.plan;
      executionStartIdx = saved.data.executionStartIdx;
    }
    if (pi.getFlag('plan') === true) planModeEnabled = true;
    if (planModeEnabled) pi.setActiveTools(resolvePlanToolsForCtx());
    updatePlanIndicator(ctx);
  }

  // ── Model switching ────────────────────────────────────────────────────────

  async function switchModel(ctx: ExtensionContext, provider: string, id: string, role: string): Promise<boolean> {
    const model = ctx.modelRegistry.find(provider, id);
    if (!model) {
      ctx.ui.notify(`[pi-plan] ${role} model ${provider}/${id} not found. Run /plan-settings.`, 'error');
      return false;
    }

    // Check if current context fits target model's context window
    const usage = ctx.getContextUsage?.();
    if (usage && usage.tokens !== null && model.contextWindow && usage.tokens > model.contextWindow) {
      ctx.ui.notify(`[pi-plan] Context (${usage.tokens}) exceeds ${id}'s window (${model.contextWindow}). Compacting...`, 'warning');
      const choice = await ctx.ui.select('Context too large — compact first?', [
        'Compact and continue',
        'Cancel',
      ]);
      if (choice !== 'Compact and continue') return false;
      await new Promise<void>((resolve, reject) => {
        ctx.compact({ onComplete: () => resolve(), onError: () => reject() });
      });
    }

    const ok = await pi.setModel(model);
    if (!ok) ctx.ui.notify(`[pi-plan] No API key for ${provider}/${id}. Run /login.`, 'error');
    return ok;
  }

  // ── File persistence for plans ─────────────────────────────────────────────

  // ── Result helper ───────────────────────────────────────────────────────────

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], details: details ?? {} };
}

function writePlanFiles(name: string, data: PlanData): void {
    const dir = planDir(name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PLAN.md'), `# ${data.title}\n\n${data.handoff}\n`, 'utf8');
    writeFileSync(join(dir, 'START-PROMPT.md'), buildExecutionPrompt(data, data.tasks) || '', 'utf8');
    writeJsonl(join(dir, 'tasks.jsonl'), [
      { _type: 'meta', title: data.title, plan_name: name, created_at: data.tasks[0]?.created_at ?? new Date().toISOString() },
      ...data.tasks,
    ]);
    // Register in global manifest
    const manifestPath = join(PLANS_ROOT, 'plans.jsonl');
    const existing = existsSync(manifestPath) ? readJsonl<any>(manifestPath) : [];
    const existingPlan = existing.find((p: any) => p.name === name);
    const entry = { name, title: data.title, status: 'in-progress' as PlanStatus, created_at: data.tasks[0]?.created_at ?? new Date().toISOString() };
    // Supersede any other in-progress plan
    for (const p of existing) {
      if (p.name !== name && p.status === 'in-progress') {
        p.status = 'superseded';
      }
    }
    if (existingPlan) Object.assign(existingPlan, entry);
    else existing.push(entry);
    writeJsonl(manifestPath, existing);
  }

  function readPlanFromDisk(dir: string): PlanData | undefined {
    const tasksPath = join(dir, 'tasks.jsonl');
    const handoffPath = join(dir, 'PLAN.md');
    if (!existsSync(tasksPath) || !existsSync(handoffPath)) return undefined;
    const rows = readJsonl<any>(tasksPath);
    const meta = rows.find((r: any) => r._type === 'meta');
    const tasks = rows.filter((r: any) => r._type !== 'meta');
    const handoff = readFileSync(handoffPath, 'utf8');
    if (!meta || tasks.length === 0) return undefined;
    return { title: meta.title, planName: meta.plan_name, handoff, tasks };
  }

  // ── Phase transitions ──────────────────────────────────────────────────────

  async function enterPlanMode(ctx: ExtensionContext): Promise<void> {
    planModeEnabled = true;
    executing = false;
    activePlanDir = undefined;
    plan = undefined;
    previousThinking = pi.getThinkingLevel() as string;
    previousModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
    pi.setActiveTools(resolvePlanToolsForCtx());
    const config = loadConfig();
    const switched = await switchModel(ctx, config.planProvider, config.planModel, 'Plan');
    if (!switched) {
      planModeEnabled = false;
      pi.setActiveTools(resolveExecToolsForCtx());
      ctx.ui.notify('[pi-plan] Could not enter plan mode.', 'error');
      return;
    }
    pi.setThinkingLevel(config.planThinking as any);
    ctx.ui.notify(`Plan mode ON — ${config.planProvider}/${config.planModel}:${config.planThinking}`, 'info');
    persistState();
    updatePlanIndicator(ctx);
  }

  async function startExecution(ctx: ExtensionContext): Promise<void> {
    if (!activePlanDir || !plan) { ctx.ui.notify('No plan to execute.', 'error'); return; }
    planModeEnabled = false;
    executing = true;
    executionStartIdx = ctx.sessionManager.getEntries().length;
    pi.setActiveTools(resolveExecToolsForCtx());
    const config = loadConfig();
    const switched = await switchModel(ctx, config.execProvider, config.execModel, 'Exec');
    if (!switched) {
      executing = false;
      planModeEnabled = true;
      pi.setActiveTools(resolvePlanToolsForCtx());
      ctx.ui.notify('[pi-plan] Could not start execution.', 'error');
      return;
    }
    pi.setThinkingLevel(config.execThinking as any);
    ctx.ui.notify(`Executing — ${config.execProvider}/${config.execModel}:${config.execThinking}`, 'info');
    persistState();
    updatePlanIndicator(ctx);
  }

  async function exitPlanMode(ctx: ExtensionContext, skipPrompt?: boolean): Promise<void> {
    // If plan has only pending tasks (unexecuted), prompt to abandon
    if (!skipPrompt && planModeEnabled && plan && plan.tasks.every(t => t.status === 'pending')) {
      const action = await ctx.ui.select('Plan has not been executed. Abandon it?', [
        'Yes, abandon',
        'Keep it',
      ]);
      if (action === 'Yes, abandon') {
        updatePlanStatusInManifest(plan.planName, 'abandoned');
      }
    }

    planModeEnabled = false;
    executing = false;
    executionStartIdx = undefined;
    pi.setActiveTools(resolveExecToolsForCtx());
    if (previousModel) await switchModel(ctx, previousModel.provider, previousModel.id, 'Restore');
    if (previousThinking) pi.setThinkingLevel(previousThinking as any);
    ctx.ui.notify('Plan mode OFF', 'info');
    persistState();
    updatePlanIndicator(ctx);
    // Inject a follow-up message to trigger a new turn.
    // New turn's before_agent_start won't inject plan prompt
    // because planModeEnabled is now false.
    pi.sendUserMessage('[SYSTEM] Plan mode exited. Normal operation resumed.', { deliverAs: 'followUp' });
  }

  // ── Task update helper ─────────────────────────────────────────────────────

  function updatePlanStatusInManifest(name: string, status: PlanStatus): void {
    const manifestPath = join(PLANS_ROOT, 'plans.jsonl');
    if (!existsSync(manifestPath)) return;
    const entries = readJsonl<any>(manifestPath);
    const plan = entries.find((p: any) => p.name === name);
    if (plan && plan.status !== status) {
      plan.status = status;
      writeJsonl(manifestPath, entries);
    }
  }

  async function updateTaskInPlan(taskId: string, status: TaskStatus, notes?: string): Promise<void> {
    if (!plan || !activePlanDir) return;
    const task = plan.tasks.find(t => t.id === taskId);
    if (!task) return;
    task.status = status;
    task.updated_at = new Date().toISOString();
    if (notes) task.notes = notes;
    writeJsonl(join(activePlanDir, 'tasks.jsonl'), [
      { _type: 'meta', title: plan.title, plan_name: plan.planName, created_at: plan.tasks[0]?.created_at ?? task.updated_at },
      ...plan.tasks,
    ]);
    persistState();
    // Auto-update plan status to 'done' when all tasks complete
    if (plan && plan.tasks.every(t => t.status === 'done' || t.status === 'skipped' || t.status === 'blocked')) {
      updatePlanStatusInManifest(plan.planName, 'done');
    }
  }

  // ── Plan list UI helper ────────────────────────────────────────────────────

  interface PlanViewEntry {
    name: string;
    title: string;
    status: PlanStatus;
    done: number;
    total: number;
    created_at: string;
  }

  function readPlansManifest(): PlanViewEntry[] {
    const manifestPath = join(PLANS_ROOT, 'plans.jsonl');
    if (!existsSync(manifestPath)) return [];
    const entries = readJsonl<any>(manifestPath);
    return entries.map((e: any) => {
      const dir = planDir(e.name);
      let done = 0, total = 0;
      try {
        const rows = readJsonl<any>(join(dir, 'tasks.jsonl'));
        const tasks = rows.filter((r: any) => r._type !== 'meta');
        total = tasks.length;
        done = tasks.filter((t: any) => t.status === 'done' || t.status === 'skipped').length;
      } catch { /* corrupted — best effort */ }
      return { name: e.name, title: e.title, status: e.status, done, total, created_at: e.created_at };
    });
  }

  async function showPlanListUI(ctx: ExtensionContext): Promise<void> {
    const entries = readPlansManifest();
    if (entries.length === 0) { ctx.ui.notify('No plans found.', 'info'); return; }

    const statusIcon: Record<string, string> = { 'in-progress': '○', done: '✓', superseded: '⊘', abandoned: '✗' };
    const planLines = entries.map(e => {
      const icon = statusIcon[e.status] || '?';
      const progress = `${e.done}/${e.total} tasks`;
      const date = e.created_at ? new Date(e.created_at).toLocaleDateString() : '';
      const active = plan && e.name === plan.planName ? ' ← active' : '';
      return `${icon} ${e.name} (${e.status}) — ${progress} · ${date}${active}`;
    });

    const picked = await ctx.ui.select('Plans:', planLines);
    if (!picked) return;

    // Extract plan name from selected line
    const match = picked.match(/^[○✓⊘✗]\s+([^\s]+)/);
    if (!match) return;
    const name = match[1];
    const entry = entries.find(e => e.name === name);
    if (!entry) return;

    // Build action menu
    const actions: string[] = [];
    if (entry.status === 'in-progress') actions.push('Resume');
    if (plan && name !== plan.planName) actions.push('Switch to this plan');
    actions.push('Abandon');
    actions.push('Delete');
    actions.push('Cancel');

    const action = await ctx.ui.select(`Plan: ${entry.name} (${entry.status})`, actions);
    if (!action || action === 'Cancel') return;

    if (action === 'Resume') {
      const resumed = readPlanFromDisk(planDir(name));
      if (!resumed) { ctx.ui.notify('Plan data corrupted.', 'error'); return; }
      activePlanDir = planDir(name);
      plan = resumed;
      const pending = plan.tasks.filter(t => t.status === 'pending' || t.status === 'deferred');
      const mode = await ctx.ui.select(`Resume "${plan.title}" — ${pending.length} pending`, [
        'Continue execution',
        'Re-enter plan mode',
        'Cancel',
      ]);
      if (mode === 'Continue execution') {
        await startExecution(ctx);
        if (pending.length > 0) pi.sendUserMessage(`Resuming plan. Start with ${pending[0].id}: ${pending[0].description}`, { deliverAs: 'followUp' });
      } else if (mode === 'Re-enter plan mode') {
        await enterPlanMode(ctx);
        pi.sendUserMessage(`Back in plan mode for "${plan.title}".`, { deliverAs: 'followUp' });
      }
      return;
    }

    if (action === 'Switch to this plan') {
      const resumed = readPlanFromDisk(planDir(name));
      if (!resumed) { ctx.ui.notify('Plan data corrupted.', 'error'); return; }
      activePlanDir = planDir(name);
      plan = resumed;
      ctx.ui.notify(`Switched to plan "${plan.title}".`, 'info');
      return;
    }

    if (action === 'Abandon') {
      updatePlanStatusInManifest(name, 'abandoned');
      ctx.ui.notify(`Plan "${entry.title}" abandoned.`, 'info');
      return;
    }

    if (action === 'Delete') {
      // Warn if deleting an active in-progress plan
      if (plan && plan.planName === name && entry.status === 'in-progress') {
        const c = await ctx.ui.select(
          `Plan "${entry.title}" is in-progress and currently active. Delete anyway?`,
          ['Yes, delete', 'Cancel']
        );
        if (c !== 'Yes, delete') return;
      }
      const confirm = await ctx.ui.select(`Delete plan "${entry.title}"? This cannot be undone.`, ['Yes, delete', 'Cancel']);
      if (confirm !== 'Yes, delete') return;
      const dir = planDir(name);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      // Remove from manifest
      const manifestPath = join(PLANS_ROOT, 'plans.jsonl');
      if (existsSync(manifestPath)) {
        const entries2 = readJsonl<any>(manifestPath);
        const filtered = entries2.filter((e: any) => e.name !== name);
        writeJsonl(manifestPath, filtered);
      }
      // Clear active plan if deleted
      if (plan && plan.planName === name) { plan = undefined; activePlanDir = undefined; }
      ctx.ui.notify(`Plan "${entry.title}" deleted.`, 'info');
    }
  }

  async function cleanCompletedPlans(ctx: ExtensionContext): Promise<void> {
    const entries = readPlansManifest();
    const deletable = entries.filter(e => e.status === 'done' || e.status === 'superseded' || e.status === 'abandoned');
    if (deletable.length === 0) { ctx.ui.notify('No completed plans to clean.', 'info'); return; }

    const statusIcon: Record<string, string> = { 'in-progress': '○', done: '✓', superseded: '⊘', abandoned: '✗' };
    const planLines = deletable.map(e => {
      const icon = statusIcon[e.status] || '?';
      const progress = `${e.done}/${e.total} tasks`;
      const date = e.created_at ? new Date(e.created_at).toLocaleDateString() : '';
      return `${icon} ${e.name} (${e.status}) — ${progress} · ${date}`;
    });

    // Add bulk action at the top
    const menuItems = [`🗑 Delete all (${deletable.length} plans)`, '', ...planLines, 'Done cleaning'];

    const picked = await ctx.ui.select('Select plan to delete (ESC to finish):', menuItems);
    if (!picked || picked === 'Done cleaning') return;

    // ── Bulk delete all ────────────────────────────────────────────────────
    if (picked.startsWith('🗑 Delete all')) {
      const activeName = plan?.planName;
      const toDelete = deletable.filter(e => e.name !== activeName);
      if (toDelete.length === 0) { ctx.ui.notify('No plans to delete (active plan excluded).', 'info'); return; }
      const confirm = await ctx.ui.select(`Delete ${toDelete.length} plan(s)? This cannot be undone.`, ['Yes, delete all', 'Cancel']);
      if (confirm !== 'Yes, delete all') return;
      const manifestPath = join(PLANS_ROOT, 'plans.jsonl');
      for (const e of toDelete) {
        const dir = planDir(e.name);
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      }
      if (existsSync(manifestPath)) {
        const all = readJsonl<any>(manifestPath);
        const deletedNames = new Set(toDelete.map(e => e.name));
        writeJsonl(manifestPath, all.filter((e: any) => !deletedNames.has(e.name)));
      }
      if (activeName) ctx.ui.notify(`Deleted ${toDelete.length} plan(s). Active plan "${activeName}" kept.`, 'info');
      else ctx.ui.notify(`Deleted ${toDelete.length} plan(s).`, 'info');
      return;
    }

    // ── Single delete ──────────────────────────────────────────────────────
    const pickMatch = picked.match(/^[○✓⊘✗]\s+([^\s(]+)/);
    const name = pickMatch?.[1] || '';
    if (!name) return;

    const entry = deletable.find(e => e.name === name);
    if (!entry) return;

    const confirm = await ctx.ui.select(`Delete plan "${entry.title}"?`, ['Yes, delete', 'Cancel']);
    if (confirm !== 'Yes, delete') return;

    const dir = planDir(name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const manifestPath = join(PLANS_ROOT, 'plans.jsonl');
    if (existsSync(manifestPath)) {
      const all = readJsonl<any>(manifestPath);
      writeJsonl(manifestPath, all.filter((e: any) => e.name !== name));
    }
    ctx.ui.notify(`Plan "${entry.title}" deleted.`, 'info');

    // Loop for more
    await cleanCompletedPlans(ctx);
  }

  // ── Flag ───────────────────────────────────────────────────────────────────

  pi.registerFlag('plan', {
    description: 'Start in plan mode (read-only + strong model)',
    type: 'boolean',
    default: false,
  });

  // ── Tools ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'submit_plan',
    description: 'Submit a plan with name, title, handoff doc, and tasks. Creates/updates .plans/<name>/ files.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case plan name' },
        title: { type: 'string', description: 'human-readable plan title' },
        handoff: { type: 'string', description: 'handoff document with full context' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string', maxLength: 60 },
              details: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      required: ['name', 'title', 'handoff', 'tasks'],
    } as any,
    execute: async (_id: string, args: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) => {
      const tasks = args.tasks || [];
      if (tasks.length === 0) return ok('No tasks provided.');
      const now = new Date().toISOString();
      const data: PlanData = {
        title: args.title,
        planName: args.name,
        handoff: args.handoff || '',
        tasks: tasks.map((t: any) => ({
          ...t,
          status: 'pending' as TaskStatus,
          origin: 'plan' as const,
          created_at: now,
          updated_at: now,
        })),
      };
      writePlanFiles(args.name, data);
      activePlanDir = planDir(args.name);
      plan = data;
      persistState();
      updatePlanIndicator(ctx);
      return ok(`Plan "${args.title}" (${args.name}) saved with ${data.tasks.length} tasks.`, { name: args.name, taskCount: data.tasks.length });
    },
  } as any);

  pi.registerTool({
    name: 'revise_plan',
    description: 'Revise an existing plan. Only pass fields that changed (title/handoff/tasks). Tasks with unchanged ids preserve status/notes.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Plan name from submit_plan' },
        title: { type: 'string' },
        handoff: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string', maxLength: 60 },
              details: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      required: ['name'],
    } as any,
    execute: async (_id: string, args: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) => {
      const dir = planDir(args.name);
      if (!existsSync(dir)) return ok(`No plan "${args.name}" found.`);
      const existing = readPlanFromDisk(dir);
      if (!existing) return ok(`Plan "${args.name}" data corrupted.`);
      const now = new Date().toISOString();
      if (args.title) existing.title = args.title;
      if (args.handoff) existing.handoff = args.handoff;
      if (args.tasks) {
        const newTasks = args.tasks.map((t: any) => {
          const old = existing.tasks.find(et => et.id === t.id);
          return {
            ...t,
            status: old?.status || 'pending',
            notes: old?.notes,
            origin: 'plan' as const,
            created_at: old?.created_at || now,
            updated_at: now,
          };
        });
        existing.tasks = newTasks;
      }
      writePlanFiles(args.name, existing);
      activePlanDir = dir;
      plan = existing;
      persistState();
      updatePlanIndicator(ctx);
      return ok(`Plan "${args.name}" revised.`, { taskCount: existing.tasks.length });
    },
  } as any);

  pi.registerTool({
    name: 'update_task',
    description: 'Mark a task done / skipped / blocked with optional notes.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['done', 'skipped', 'blocked'] },
        notes: { type: 'string' },
      },
      required: ['task_id', 'status'],
    } as any,
    execute: async (_id: string, args: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) => {
      if (!plan || !activePlanDir) return ok('No active plan.');
      await updateTaskInPlan(args.task_id, args.status, args.notes);
      updatePlanIndicator(ctx);
      return ok(`Task ${args.task_id} marked ${args.status}.`, { task_id: args.task_id, status: args.status });
    },
  } as any);

  pi.registerTool({
    name: 'update_tasks',
    description: 'Mark several tasks done/skipped/blocked in one call (coalesced write).',
    parameters: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              task_id: { type: 'string' },
              status: { type: 'string', enum: ['done', 'skipped', 'blocked'] },
              notes: { type: 'string' },
            },
            required: ['task_id', 'status'],
          },
        },
      },
      required: ['updates'],
    } as any,
    execute: async (_id: string, args: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) => {
      if (!plan || !activePlanDir) return ok('No active plan.');
      for (const u of args.updates) await updateTaskInPlan(u.task_id, u.status, u.notes);
      updatePlanIndicator(ctx);
      return ok(`${args.updates.length} tasks updated.`, { count: args.updates.length });
    },
  } as any);

  pi.registerTool({
    name: 'add_task',
    description: 'Capture a discovered follow-up task (deferred — not executed now).',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', maxLength: 60 },
        reason: { type: 'string', description: 'Why this follow-up matters' },
        details: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' } },
      },
      required: ['description', 'reason'],
    } as any,
    execute: async (_id: string, args: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: ExtensionContext) => {
      if (!plan || !activePlanDir) return ok('No active plan.');
      const now = new Date().toISOString();
      const taskId = `t-${String(plan.tasks.length + 1).padStart(3, '0')}`;
      const task: TaskRecord = {
        id: taskId,
        description: args.description,
        details: args.details,
        status: 'deferred',
        origin: 'discovered',
        depends_on: args.depends_on,
        created_at: now,
        updated_at: now,
      };
      if (args.reason) task.notes = `Reason: ${args.reason}`;
      plan.tasks.push(task);
      writeJsonl(join(activePlanDir, 'tasks.jsonl'), [
        { _type: 'meta', title: plan.title, plan_name: plan.planName, created_at: plan.tasks[0]?.created_at ?? now },
        ...plan.tasks,
      ]);
      persistState();
      updatePlanIndicator(ctx);
      return ok(`Follow-up "${args.description}" captured as ${taskId} (deferred). Review via /plan resume.`, { task_id: taskId });
    },
  } as any);

  pi.registerTool({
    name: 'plan_status',
    description: 'Read-only snapshot of active plan progress.',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Plan name (optional)' },
      },
    } as any,
    execute: async (_id: string, _args: any, _signal: AbortSignal | undefined, _onUpdate: any, _ctx: ExtensionContext) => {
      if (plan) {
        const done = plan.tasks.filter(t => t.status === 'done').length;
        const total = plan.tasks.length;
        return ok(`Plan: ${plan.title} (${plan.planName})\nProgress: ${done}/${total} tasks complete`, { done, total });
      }
      return ok('No active plan.');
    },
  } as any);

  pi.registerTool({
    name: 'reconcile_plans',
    description: 'Detect & repair drift between tasks.jsonl and the registry.',
    parameters: { type: 'object', properties: {} } as any,
    execute: async (_id: string, _args: any, _signal: AbortSignal | undefined, _onUpdate: any, _ctx: ExtensionContext) => {
      const manifestPath = join(PLANS_ROOT, 'plans.jsonl');
      if (!existsSync(manifestPath)) return ok('No plans directory.');
      const entries = readJsonl<any>(manifestPath);
      let report = '';
      for (const entry of entries) {
        const dir = planDir(entry.name);
        if (!existsSync(join(dir, 'tasks.jsonl'))) { report += `\n⚠ ${entry.name}: tasks.jsonl missing`; continue; }
        const rows = readJsonl<any>(join(dir, 'tasks.jsonl'));
        const tasks = rows.filter((r: any) => r._type !== 'meta');
        const allDone = tasks.every((t: any) => t.status === 'done' || t.status === 'skipped');
        const expectedStatus = allDone ? 'done' : 'in-progress';
        if (entry.status !== expectedStatus) {
          entry.status = expectedStatus;
          report += `\n✓ ${entry.name}: status → ${expectedStatus}`;
        }
      }
      writeJsonl(manifestPath, entries);
      return ok(report || 'No drift detected.');
    },
  } as any);

  // ── Commands ───────────────────────────────────────────────────────────────

  pi.registerCommand('plan', {
    description: 'Plan mode + subcommands: list|ls, clean, resume, abandon, exit|off|out, help. Try /plan help.',
    handler: async (args, ctx) => {
      const trimmed = args?.trim();

      // ── /plan exit | off | out : immediate exit, no dialog ─────────────────
      if (trimmed === 'exit' || trimmed === 'off' || trimmed === 'out') {
        if (!planModeEnabled && !executing) {
          ctx.ui.notify('Not in plan mode.', 'info');
          return;
        }
        await exitPlanMode(ctx);
        return;
      }

      // ── /plan abandon : mark current plan as abandoned ───────────────────
      if (trimmed === 'abandon') {
        if (!plan) { ctx.ui.notify('No active plan to abandon.', 'info'); return; }
        const confirm = await ctx.ui.select(`Abandon plan "${plan.title}"?`, [
          'Yes, abandon',
          'Cancel',
        ]);
        if (confirm !== 'Yes, abandon') return;
        updatePlanStatusInManifest(plan.planName, 'abandoned');
        if (planModeEnabled || executing) await exitPlanMode(ctx);
        ctx.ui.notify(`Plan "${plan.title}" abandoned.`, 'info');
        return;
      }

      if (trimmed === 'resume') {
        // Scan .plans/ for in-progress plans
        if (!existsSync(PLANS_ROOT)) { ctx.ui.notify('No plans directory.', 'info'); return; }
        const dirs = readdirSync(PLANS_ROOT).filter(d => {
          try { return existsSync(join(PLANS_ROOT, d, 'tasks.jsonl')) && existsSync(join(PLANS_ROOT, d, 'PLAN.md')); } catch { return false; }
        });
        if (dirs.length === 0) { ctx.ui.notify('No saved plans found.', 'info'); return; }

        // Pick one
        const choice = await ctx.ui.select('Resume plan:', dirs);
        if (!choice) return;
        const resumed = readPlanFromDisk(planDir(choice));
        if (!resumed) { ctx.ui.notify('Plan data corrupted.', 'error'); return; }

        activePlanDir = planDir(choice);
        plan = resumed;
        const pending = plan.tasks.filter(t => t.status === 'pending' || t.status === 'deferred');

        if (pending.length === 0 && plan.tasks.every(t => t.status === 'done' || t.status === 'skipped')) {
          ctx.ui.notify(`Plan "${plan.title}" already complete.`, 'info');
          return;
        }

        // Ask: resume execution or re-enter planning
        const mode = await ctx.ui.select(`Resume "${plan.title}" — ${pending.length} pending tasks`, [
          'Continue execution',
          'Re-enter plan mode',
          'Cancel',
        ]);
        if (mode === 'Continue execution') {
          await startExecution(ctx);
          if (pending.length > 0) {
            pi.sendUserMessage(`Resuming plan "${plan.title}". Current task: ${pending[0].id}. ${pending[0].description}`);
          }
        } else if (mode === 'Re-enter plan mode') {
          await enterPlanMode(ctx);
          pi.sendUserMessage(`Back in plan mode for "${plan.title}". What needs to change?`);
        }
        return;
      }

      // ── /plan list | ls : show all plans ─────────────────────────────────
      if (trimmed === 'list' || trimmed === 'ls') {
        await showPlanListUI(ctx);
        return;
      }

      // ── /plan clean : delete completed plans ─────────────────────────────
      if (trimmed === 'clean') {
        await cleanCompletedPlans(ctx);
        return;
      }

      // ── /plan help : show available subcommands ─────────────────────────
      if (trimmed === 'help' || trimmed === '-h' || trimmed === '--help') {
        ctx.ui.notify(
          '📋 Available subcommands:\n' +
          '  /plan           — Toggle plan mode\n' +
          '  /plan exit|off|out — Leave plan mode\n' +
          '  /plan list|ls   — Show all plans\n' +
          '  /plan clean     — Delete completed plans\n' +
          '  /plan resume    — Resume a saved plan\n' +
          '  /plan abandon   — Mark current plan as abandoned\n' +
          '  /plan help      — Show this help\n' +
          '  /todos          — Show current plan progress',
          'info'
        );
        return;
      }

      // ── Unknown subcommand → show help ──────────────────────────────────
      if (trimmed && trimmed !== '') {
        ctx.ui.notify(`Unknown subcommand: /plan ${trimmed}. Try /plan help for available commands.`, 'warning');
        return;
      }

      // Toggle plan mode
      if (planModeEnabled || executing) {
        await exitPlanMode(ctx);
      } else {
        await enterPlanMode(ctx);
        if (trimmed) pi.sendUserMessage(trimmed);
      }
    },
  });

  // ── Independent subcommands (CLI Tab-completable) ──────────────────────────

  pi.registerCommand('plan-list', {
    description: 'Show all plans (alias for /plan list)',
    handler: async (_args, ctx) => { await showPlanListUI(ctx); },
  });

  pi.registerCommand('plan-clean', {
    description: 'Delete completed plans (alias for /plan clean)',
    handler: async (_args, ctx) => { await cleanCompletedPlans(ctx); },
  });

  pi.registerCommand('plan-abandon', {
    description: 'Mark current plan as abandoned',
    handler: async (_args, ctx) => {
      if (!plan) { ctx.ui.notify('No active plan to abandon.', 'info'); return; }
      const confirm = await ctx.ui.select(`Abandon plan "${plan.title}"?`, ['Yes, abandon', 'Cancel']);
      if (confirm !== 'Yes, abandon') return;
      updatePlanStatusInManifest(plan.planName, 'abandoned');
      if (planModeEnabled || executing) await exitPlanMode(ctx);
      ctx.ui.notify(`Plan "${plan.title}" abandoned.`, 'info');
    },
  });

  pi.registerCommand('plan-resume', {
    description: 'Resume a saved plan (alias for /plan resume)',
    handler: async (_args, ctx) => {
      if (!existsSync(PLANS_ROOT)) { ctx.ui.notify('No plans directory.', 'info'); return; }
      const dirs = readdirSync(PLANS_ROOT).filter(d => {
        try { return existsSync(join(PLANS_ROOT, d, 'tasks.jsonl')) && existsSync(join(PLANS_ROOT, d, 'PLAN.md')); } catch { return false; }
      });
      if (dirs.length === 0) { ctx.ui.notify('No saved plans found.', 'info'); return; }
      const choice = await ctx.ui.select('Resume plan:', dirs);
      if (!choice) return;
      const resumed = readPlanFromDisk(planDir(choice));
      if (!resumed) { ctx.ui.notify('Plan data corrupted.', 'error'); return; }
      activePlanDir = planDir(choice);
      plan = resumed;
      const pending = plan.tasks.filter(t => t.status === 'pending' || t.status === 'deferred');
      if (pending.length === 0 && plan.tasks.every(t => t.status === 'done' || t.status === 'skipped')) {
        ctx.ui.notify(`Plan "${plan.title}" already complete.`, 'info');
        return;
      }
      const mode = await ctx.ui.select(`Resume "${plan.title}" — ${pending.length} pending tasks`, [
        'Continue execution', 'Re-enter plan mode', 'Cancel',
      ]);
      if (mode === 'Continue execution') {
        await startExecution(ctx);
        if (pending.length > 0) pi.sendUserMessage(`Resuming plan "${plan.title}". Current task: ${pending[0].id}. ${pending[0].description}`);
      } else if (mode === 'Re-enter plan mode') {
        await enterPlanMode(ctx);
        pi.sendUserMessage(`Back in plan mode for "${plan.title}". What needs to change?`);
      }
    },
  });

  pi.registerCommand('plan-exit', {
    description: 'Leave plan/exec mode (alias for /plan exit)',
    handler: async (_args, ctx) => {
      if (!planModeEnabled && !executing) { ctx.ui.notify('Not in plan mode.', 'info'); return; }
      await exitPlanMode(ctx);
    },
  });

  pi.registerCommand('plan-help', {
    description: 'Show /plan subcommand help',
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        '📋 Available subcommands:\n' +
        '  /plan           — Toggle plan mode\n' +
        '  /plan-list      — Show all plans\n' +
        '  /plan-clean     — Delete completed plans\n' +
        '  /plan-resume    — Resume a saved plan\n' +
        '  /plan-abandon   — Mark current plan as abandoned\n' +
        '  /plan-exit      — Leave plan mode\n' +
        '  /plan-help      — Show this help\n' +
        '  /plan-settings  — Configure models/bash/tools\n' +
        '  /todos          — Show current plan progress',
        'info'
      );
    },
  });

  pi.registerCommand('todos', {
    description: 'Show current plan progress.',
    handler: async (_args, ctx) => {
      if (!plan || plan.tasks.length === 0) { ctx.ui.notify('No plan yet.', 'info'); return; }
      const icon: Record<string, string> = { pending: '○', done: '✓', skipped: '⊘', blocked: '✗', deferred: '⏸' };
      const list = plan.tasks.map(t => `${t.id}. ${icon[t.status] || '○'} ${t.description}${t.origin === 'discovered' ? ' (discovered)' : ''}`).join('\n');
      ctx.ui.notify(`Plan Progress — ${plan.title}:\n${list}`, 'info');
    },
  });

  // ── applyConfigIfActive: immediate live-apply when in plan/exec mode ────────

  async function applyConfigIfActive(ctx: ExtensionContext, cfg: PlanConfig): Promise<void> {
    if (planModeEnabled) {
      const switched = await switchModel(ctx, cfg.planProvider, cfg.planModel, 'Plan');
      if (switched) pi.setThinkingLevel(cfg.planThinking as any);
    } else if (executing) {
      const switched = await switchModel(ctx, cfg.execProvider, cfg.execModel, 'Exec');
      if (switched) pi.setThinkingLevel(cfg.execThinking as any);
    }
  }

  pi.registerCommand('plan-settings', {
    description: 'Unified settings: plan/exec models, thinking, bash safety mode.',
    handler: async (_args, ctx) => {
      const allModels = ctx.modelRegistry?.getAvailable() || [];
      if (allModels.length === 0) { ctx.ui.notify('No models configured. Use /login first.', 'error'); return; }

      // Group by provider
      const byProvider = new Map<string, string[]>();
      for (const m of allModels) {
        const list = byProvider.get(m.provider) || [];
        list.push(m.id);
        byProvider.set(m.provider, list);
      }
      const providers = [...byProvider.keys()];

      const THINKING_OPTIONS = ['off', 'low', 'medium', 'high'];

      // Helper: pick provider → model
      async function pickModel(role: string, currentP: string, currentM: string): Promise<{ provider: string; model: string } | undefined> {
        const provLabel = await ctx.ui.select(`${role} — provider:`, providers.map(p => `${p}${p === currentP ? ' (current)' : ''}`));
        if (!provLabel) return undefined;
        const prov = provLabel.replace(/\s*\(current\)$/, '');
        const models = byProvider.get(prov) || [];
        const modelLabel = await ctx.ui.select(`${role} — model (${prov}):`, models.map(m => `${m}${m === currentM && prov === currentP ? ' (current)' : ''}`));
        if (!modelLabel) return undefined;
        return { provider: prov, model: modelLabel.replace(/\s*\(current\)$/, '') };
      }

      let exit = false;
      while (!exit) {
        const cfg = loadConfig();
        const choices = [
          `1. Plan model: ${cfg.planProvider}/${cfg.planModel}`,
          `2. Plan thinking: ${cfg.planThinking}`,
          '',
          `3. Exec model: ${cfg.execProvider}/${cfg.execModel}`,
          `4. Exec thinking: ${cfg.execThinking}`,
          '',
          `5. Bash safety mode: ${cfg.bashSafetyMode}`,
          `6. Plan blocked tools: ${(loadProjectConfig(ctx.cwd).planBlockedTools || []).join(', ') || '(none)'}`,
          '',
          '0. Exit',
        ];

        const answer = await ctx.ui.select('Plan Settings', choices);
        if (!answer) { exit = true; break; }

        if (answer.startsWith('1.')) {
          const picked = await pickModel('Plan model (planning, strong)', cfg.planProvider, cfg.planModel);
          if (!picked) continue;
          cfg.planProvider = picked.provider;
          cfg.planModel = picked.model;
          saveConfig(cfg);
          await applyConfigIfActive(ctx, cfg);
          ctx.ui.notify(`Plan model → ${cfg.planProvider}/${cfg.planModel}`, 'info');
        } else if (answer.startsWith('2.')) {
          const level = await ctx.ui.select('Plan thinking level', THINKING_OPTIONS);
          if (!level) continue;
          cfg.planThinking = level;
          saveConfig(cfg);
          await applyConfigIfActive(ctx, cfg);
          ctx.ui.notify(`Plan thinking → ${cfg.planThinking}`, 'info');
        } else if (answer.startsWith('3.')) {
          const picked = await pickModel('Exec model (execution, light)', cfg.execProvider, cfg.execModel);
          if (!picked) continue;
          cfg.execProvider = picked.provider;
          cfg.execModel = picked.model;
          saveConfig(cfg);
          await applyConfigIfActive(ctx, cfg);
          ctx.ui.notify(`Exec model → ${cfg.execProvider}/${cfg.execModel}`, 'info');
        } else if (answer.startsWith('4.')) {
          const level = await ctx.ui.select('Exec thinking level', THINKING_OPTIONS);
          if (!level) continue;
          cfg.execThinking = level;
          saveConfig(cfg);
          await applyConfigIfActive(ctx, cfg);
          ctx.ui.notify(`Exec thinking → ${cfg.execThinking}`, 'info');
        } else if (answer.startsWith('5.')) {
          const mode = await ctx.ui.select('Bash safety mode', [
            `blacklist${cfg.bashSafetyMode === 'blacklist' ? ' (current)' : ''}`,
            `allowlist${cfg.bashSafetyMode === 'allowlist' ? ' (current)' : ''}`,
          ]);
          if (!mode) continue;
          const clean = mode.replace(/\s*\(current\)$/, '') as 'blacklist' | 'allowlist';
          cfg.bashSafetyMode = clean;
          saveConfig(cfg);
          ctx.ui.notify(`Bash safety mode → ${cfg.bashSafetyMode}`, 'info');
        } else if (answer.startsWith('6.')) {
          // Project-level: show all non-blocked tools, let user pick which to block
          const allToolNames = pi.getAllTools().map(t => t.name);
          const projCfg = loadProjectConfig(ctx.cwd);
          const currentBlocked = new Set([...PLAN_BLOCKED_TOOLS, ...(projCfg.planBlockedTools || [])]);
          const blockable = allToolNames.filter(n => !currentBlocked.has(n));
          if (blockable.length === 0) { ctx.ui.notify('All tools already blocked.', 'info'); continue; }
          const toolName = await ctx.ui.select('Block tool in plan mode (ESC to cancel):', blockable);
          if (!toolName) continue;
          const blocked = [...(projCfg.planBlockedTools || []), toolName];
          saveProjectConfig(ctx.cwd, { planBlockedTools: blocked });
          ctx.ui.notify(`Plan blocked tools → ${blocked.join(', ')} (saved to .pi/pi-plan.json)`, 'info');
        } else if (answer.startsWith('0.')) {
          exit = true;
        }
        // else (blank separator or section header) → loop
      }
    },
  });

  pi.registerShortcut(Key.ctrlAlt('p'), {
    description: 'Toggle plan mode',
    handler: async (ctx) => {
      if (planModeEnabled || executing) await exitPlanMode(ctx);
      else await enterPlanMode(ctx);
    },
  });

  // ── Event: block destructive bash + restrict writes ────────────────────────
  //
  // Instead of silently blocking, pop a dialog so the user can either exit
  // plan mode on the spot, type alternative instructions, or cancel.

  async function promptOnBlock(ctx: ExtensionContext, originalReason: string): Promise<{ block: true; reason: string } | undefined> {
    const choice = await ctx.ui.select('Plan 模式拦截了此操作', [
      '退出并执行',
      '取消',
    ]);

    if (choice === '退出并执行') {
      await exitPlanMode(ctx, true);
      // Allow the tool call (the block was a false positive or user wants to
      // execute it anyway). exitPlanMode already injected a follow-up message
      // that triggers a new clean turn.
      return undefined;
    }

    // Cancel / Escape / fallthrough
    return { block: true, reason: originalReason };
  }

  pi.on('tool_call', async (event, ctx) => {
    if (!planModeEnabled) return;

    let originalReason: string | undefined;

    if (event.toolName === 'bash') {
      const cmd = event.input.command as string;
      if (!isSafeCommand(cmd) || hasOutputRedirect(cmd)) {
        originalReason = `Plan mode (${getBashSafetyMode()}): command blocked. Use /plan to exit, /plan-settings to switch.
Command: ${cmd}`;
      }
    }
    if ((event.toolName === 'write' || event.toolName === 'edit') && !originalReason) {
      const p = event.input.path as string;
      if (!isPlanPath(p)) {
        originalReason = `Plan mode: writes restricted to .plans/ directory.\nPath: ${p}`;
      }
    }

    if (!originalReason) return;
    if (!ctx.hasUI) return { block: true, reason: originalReason };

    return promptOnBlock(ctx, originalReason);
  });

  // ── Event: inject phase prompts ────────────────────────────────────────────

  pi.on('before_agent_start', async () => {
    if (planModeEnabled) {
      return { message: { customType: 'pi-plan-context', content: buildPlanModePrompt(resolvePlanToolsForCtx()), display: false } };
    }
    if (executing && plan) {
      const remaining = plan.tasks.filter(t => t.status === 'pending' || t.status === 'deferred');
      const content = buildExecutionPrompt(plan, remaining);
      if (content) return { message: { customType: 'pi-plan-execution-context', content, display: false } };
    }
  });

  // ── Event: agent_end — plan confirmation, blocked tasks, completion ────────

  pi.on('agent_end', async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // ── Execution phase: blocked task handling ──
    if (executing && plan) {
      const blocked = plan.tasks.filter(t => t.status === 'blocked');
      if (blocked.length > 0) {
        const bs = blocked[0];
        let info = bs.notes ? `Task ${bs.id}: ${bs.description}\nReason: ${bs.notes}` : `Task ${bs.id}: ${bs.description}`;
        const deferredCount = plan.tasks.filter(t => t.status === 'deferred').length;
        if (deferredCount > 0) info += `\n\nNote: ${deferredCount} follow-up(s) captured.`;

        const choice = await ctx.ui.select(`Task blocked — ${info}\n\nWhat next?`, [
          'Skip this task',
          'Provide instructions',
          'Re-plan',
          'Abort execution',
        ]);

        if (choice === 'Skip this task') {
          await updateTaskInPlan(bs.id, 'skipped');
          const next = plan.tasks.filter(t => t.status === 'pending');
          if (next.length > 0) {
            pi.sendUserMessage(`Skipped ${bs.id}. Continue with ${next[0].id}: ${next[0].description}`, { deliverAs: 'followUp' });
          }
        } else if (choice === 'Provide instructions') {
          const instructions = await ctx.ui.editor('Instructions for the blocked task:', '');
          if (instructions?.trim()) {
            await updateTaskInPlan(bs.id, 'pending');
            pi.sendUserMessage(`Retry ${bs.id} with: ${instructions.trim()}`, { deliverAs: 'followUp' });
          }
        } else if (choice === 'Re-plan') {
          await enterPlanMode(ctx);
          pi.sendUserMessage(`Task ${bs.id} blocked: ${bs.notes || 'no details'}. Re-analyze and revise.`, { deliverAs: 'followUp' });
        } else if (choice === 'Abort execution') {
          await exitPlanMode(ctx);
        }
        persistState();
        return;
      }

      // ── Execution phase: completion check ──
      const pending = plan.tasks.filter(t => t.status === 'pending' || t.status === 'deferred');
      if (pending.length === 0) {
        const choice = await ctx.ui.select(`Plan "${plan.title}" complete! ✓`, [
          'Exit plan mode',
          'Stay in execution mode',
        ]);
        if (choice === 'Exit plan mode') await exitPlanMode(ctx);
        return;
      }
    }

    // ── Plan phase: extract todos and show confirmation ──
    if (planModeEnabled && plan && plan.tasks.length > 0) {
      const choice = await ctx.ui.select('Plan ready — what next?', [
        'Execute the plan',
        'Stay in plan mode',
        'Refine the plan',
      ]);

      if (choice === 'Execute the plan') {
        await startExecution(ctx);
        const first = plan.tasks.find(t => t.status === 'pending');
        if (first) pi.sendUserMessage(`Execute plan "${plan.title}". Start with ${first.id}: ${first.description}`, { deliverAs: 'followUp' });
      } else if (choice === 'Refine the plan') {
        const refinement = await ctx.ui.editor('Refine the plan:', '');
        if (refinement?.trim()) pi.sendUserMessage(refinement.trim());
      }
    }
  });

  // ── Event: session_start — restore state ───────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    restoreState(ctx);
    if (planModeEnabled && !plan && existsSync(PLANS_ROOT)) {
      // Auto-attach plan if one exists on disk
      const dirs = readdirSync(PLANS_ROOT).filter(d => {
        try { return existsSync(join(PLANS_ROOT, d, 'tasks.jsonl')); } catch { return false; }
      });
      for (const d of dirs) {
        const p = readPlanFromDisk(planDir(d));
        if (p && p.tasks.some(t => t.status === 'blocked' || t.status === 'pending')) {
          activePlanDir = planDir(d);
          plan = p;
          break;
        }
      }
    }
    updatePlanIndicator(ctx);
  });

  // ── Event: session_shutdown — cleanup ──────────────────────────────────────

  pi.on('session_shutdown', () => {
    // no-op: state persists on disk
  });
}
