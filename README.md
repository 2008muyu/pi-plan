# @2008muyu/pi-plan

> Configurable two-phase planning workflow for [pi coding agent](https://github.com/earendil-works/pi-coding-agent).
> Plan with a **strong model**, execute with a **light model** — all models fully configurable.

[中文版](#中文说明)

## Why?

Existing plan-mode extensions hardcode model settings. `@2008muyu/pi-plan` lets you choose:

- **Planning model** — strong reasoning (e.g. `claude-opus-4-6`, `gemini-3-pro`, `deepseek-r1`)
- **Execution model** — lightweight for saving tokens (e.g. `gpt-5.5`, `claude-sonnet-4`)

Configure once via `/plan-settings`, then just `/plan` and go.

## Install

```bash
pi install npm:@2008muyu/pi-plan
```

Or from GitHub:
```bash
pi install git:github.com/2008muyu/pi-plan
```

Restart pi (or run `:reload`).

## Usage

### `/plan` — Enter plan mode

```bash
/plan add authentication middleware with JWT support
```

Pi switches to your configured **plan model**, restricts tools to read-only (read/grep/find/ls), and the agent analyzes the codebase. Once ready, it calls `submit_plan` to create `.plans/<name>/PLAN.md`.

When the plan is done, you get a menu:
- **Execute the plan** — switches to the **execution model**, restores full tools
- **Stay in plan mode** — keep refining
- **Refine the plan** — edit the plan interactively

### `/plan resume` — Resume a saved plan

```bash
/plan resume
```

Lists all in-progress plans from disk. Pick one to continue execution or re-enter planning.

### `/plan list` — Show all plans

```bash
/plan list   # or /plan ls
```

Shows all saved plans with status and progress. Select one to resume, abandon, switch to, or delete.

### `/plan clean` — Delete completed plans

```bash
/plan clean
```

Lists all done / superseded / abandoned plans for deletion. Select which to remove.

### `/plan abandon` — Abandon current plan

```bash
/plan abandon
```

Marks the current plan as abandoned (without deleting its files).

### `/plan-settings` — Unified settings

Opens an interactive menu for:
- Plan model provider + ID + thinking level
- Exec model provider + ID + thinking level
- Bash safety mode (blacklist / allowlist)
- Plan blocked tools (project-level, saved to `.pi/pi-plan.json`)

### `/todos` — View progress

Shows all tasks with status icons.

| Icon | Status |
|------|--------|
| ○ | Pending |
| ✓ | Done |
| ⊘ | Skipped |
| ✗ | Blocked |
| ⏸ | Deferred (discovered) |

### Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+P` | Toggle plan mode |

## Configuration

Config stored in `~/.pi/agent/pi-plan.json`. Also supports environment variables:

| Env variable | Default | Description |
|-------------|---------|-------------|
| `PI_PLAN_PROVIDER` | `anthropic` | Planning model provider |
| `PI_PLAN_MODEL` | `claude-opus-4-6` | Planning model ID |
| `PI_PLAN_THINKING` | `medium` | Planning thinking level |
| `PI_EXEC_PROVIDER` | `openai` | Execution model provider |
| `PI_EXEC_MODEL` | `gpt-5.5` | Execution model ID |
| `PI_EXEC_THINKING` | `low` | Execution thinking level |

## Tools

| Tool | Phase | Purpose |
|------|-------|---------|
| `submit_plan` | Plan | Submit finalized plan with tasks |
| `revise_plan` | Plan | Revise an existing plan |
| `update_task` | Exec | Mark task done/skipped/blocked |
| `update_tasks` | Exec | Batch task update |
| `add_task` | Exec | Capture discovered follow-up |
| `plan_status` | Any | Read-only snapshot |
| `reconcile_plans` | Any | Repair task/registry drift |

## Plan Lifecycle

Plans have a lifecycle with automatic state transitions:

| State | Trigger |
|-------|---------|
| `in-progress` | Plan submitted via `submit_plan` |
| `done` | All tasks completed (auto-detected) |
| `superseded` | New plan started while another was in-progress (auto-detected) |
| `abandoned` | User marks via `/plan abandon`, or prompted on exit if plan was never executed |

Tracked in `.plans/plans.jsonl`. Use `/plan list` to view, `/plan clean` to remove completed ones.

## Project-Level Tool Blocking

In addition to the default blocked tools (edit/write, exec-only), you can block project-specific tools in plan mode:

```json
// .pi/pi-plan.json
{ "planBlockedTools": ["godot_create_node", "godot_set_cell"] }
```

Configured via `/plan-settings` → option 6, or edit the file manually. This is project-scoped — different projects can have different blocked tools.

## Blocked Task Handling

When a task is blocked during execution, a menu appears:
1. **Skip** — skip and continue
2. **Provide instructions** — give guidance, retry
3. **Re-plan** — go back to plan mode
4. **Abort** — exit plan mode

## How it works

```
/plan → enterPlanMode()
  → save current model
  → switch to plan model
  → restrict to read-only tools
  → inject plan prompt

Agent analyzes → submit_plan
  → .plans/<name>/ files created

Execute → startExecution()
  → switch to exec model
  → restore full tools
  → inject execution prompt

Agent completes tasks → update_task
  → blocked? → menu → skip/instruct/re-plan/abort
  → done? → exit or stay
```

---

# 中文说明

## 简介

**@2008muyu/pi-plan** 是一个可配置的双阶段规划扩展。规划用强模型（思考深入），执行用轻模型（省 token），所有模型均可通过 `/plan-settings` 统一设置。

## 安装

```bash
pi install npm:@2008muyu/pi-plan
```

或从 GitHub 安装：
```bash
pi install git:github.com/2008muyu/pi-plan
```

重启 pi（或运行 `:reload`）。

## 使用方法

### `/plan` — 进入规划模式

```bash
/plan 添加 JWT 认证中间件
```

pi 自动切换到配置的**规划模型**，工具限制为只读模式。Agent 分析代码后调用 `submit_plan` 提交方案。确认后可选择执行、继续规划或修改方案。

### `/plan resume` — 恢复已保存的方案

显示磁盘上所有进行中的方案，选择继续执行或重新规划。

### `/plan-settings` — 统一设置

交互菜单统一配置规划/执行模型的 provider、ID、思考强度，以及 bash 安全模式。

### `/todos` — 查看进度

显示所有任务及其状态。

### Blocked 任务处理

执行阶段如果任务被阻塞，弹菜单：跳过、提供说明重试、重新规划、终止执行。

## 配置

配置文件 `~/.pi/agent/pi-plan.json`，也支持环境变量（见上方英文表格）。

## 许可证

MIT
