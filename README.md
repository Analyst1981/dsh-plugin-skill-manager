# dsh-plugin-skill-manager

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that manages your **skills** — the Claude Code-style `SKILL.md` instruction files that DSH loads from your project and user directories.

It adds two surfaces to any DSH profile built on `@deepseek-ai/dsh-base`:

- **`skill_manager` tool** — the model can list, inspect, create, update, delete, validate, enable, and disable skills directly in a conversation.
- **`/skills` command** — you can manage the same library from the chat input without spending a single token.

Every file this plugin writes follows the exact discovery contract of [`@deepseek-ai/dsh-skill-filesystem`](https://www.npmjs.com/package/@deepseek-ai/dsh-skill-filesystem) (same roots, same precedence, same frontmatter fields), so mutations are picked up by the live skill registry within its usual watcher stability window — the session's available-skills catalog updates without a restart.

## Install

```sh
dsh plugin --profile web add dsh-plugin-skill-manager
```

Then restart the profile (`dsh web`). Any other profile works the same way. To install a specific version or a git checkout:

```sh
dsh plugin --profile web add dsh-plugin-skill-manager@0.1.0
dsh plugin --profile web add github:user/dsh-plugin-skill-manager
```

To remove:

```sh
dsh plugin --profile web remove dsh-plugin-skill-manager
```

## What it manages

The same roots, in the same precedence order, as the shipped filesystem provider:

| Rank | Source | Path |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | configured `customSkillDirs` |
| 400 | `user-dsh` | `~/.dsh/skills` |
| 500 | `user-agents` | `~/.agents/skills` |

Skills are `<name>/SKILL.md` bundles or flat `<name>.md` files with YAML frontmatter:

```yaml
---
name: my-skill
description: What this skill does, shown in the catalog.
whenToUse: Optional extra routing hint.
disable-model-invocation: false   # true hides the skill from the model
user-invocable: true              # false hides it from human commands
---
Body instructions the model reads verbatim when the skill is invoked.
```

`name` + `description` are required; `whenToUse`, `metadata`, and the two invocation keys are optional (the plugin only writes the invocation keys when restricting, so default files stay Claude Code-clean).

## The `skill_manager` tool

| Action | Key arguments | What it does |
|---|---|---|
| `list` | — | Every skill file across all roots with path, format, source, invocation state, plus shadowed-duplicate and live-registry flags. |
| `inspect` | `name` | Full frontmatter and body preview for every entry declaring that name. |
| `create` | `name`, `description`, `content?`, `scope?` (`user` \| `project`), `when_to_use?`, `model_invocable?`, `user_invocable?` | Scaffolds a valid skill (refuses to clobber an existing name). Default scope comes from config. |
| `update` | `name` + any of `description?`, `when_to_use?`, `content?`, `model_invocable?`, `user_invocable?` | Merges frontmatter in place, preserves unknown keys, replaces body only when `content` is given. |
| `delete` | `name`, `confirm: true` | Removes the bundle directory or flat file. The explicit `confirm` flag is mandatory. |
| `validate` | `name?` | Reports broken skill files the loader silently skips (bad YAML, missing fields, bad names) plus ignored directories and unreadable roots. |
| `roots` | — | The resolved root list with ranks. |

Example — ask the model in a DSH session:

> 用 skill_manager 建一个 skill：名字 `pdf-report`，描述"生成 PDF 周报"，正文按我们刚讨论的模板写。

## The `/skills` command

Runs entirely in the UI command plane (output never enters model history):

```text
/skills                              # list everything with status
/skills show pdf-report              # frontmatter + body preview
/skills create pdf-report 生成 PDF 周报  # scaffold, then ask the model to fill the body
/skills disable pdf-report           # hide from the model (disable-model-invocation: true)
/skills enable pdf-report
/skills delete pdf-report --yes      # permanent; --yes is required
/skills validate                     # check every skill file
/skills roots                        # show scanned directories
```

## Configuration

Patch the row in your profile's `cordis.patch.yml` (`dsh plugin` installs it with defaults; no configuration is required):

```yaml
- id: skill-manager
  config:
    defaultScope: user        # where /skills create and bare create put skills
    bodyPreviewChars: 600      # preview length in inspect/show output
    customSkillDirs: []        # extra roots, scanned at rank 300
    # dshHome / agentsHome override $DSH_HOME / $DSH_AGENTS_HOME
```

## Design notes

- **Reads cross-check the live registry.** `list` annotates each entry with whether the `ctx.skills` registry currently serves it, so a shadowed duplicate (e.g. a project skill overriding your user skill) is visible at a glance.
- **Deletes are guarded.** `delete` only accepts names discovered by the plugin's own scan — never caller-supplied paths — re-reads the target before removing, and refuses when the file's declared name changed since the scan.
- **Diagnostics over silence.** The shipped provider hides malformed entries with a log line; `validate` surfaces them with exact reasons.
- **No build step.** Plain ESM JavaScript; `npm test` runs the unit and integration suites (the integration suite boots a real cordis context with the actual dsh services).

## Compatibility

- DeepSeek Harness `@deepseek-ai/dsh` `0.1.0-rc.x` profiles built on `dsh-base` (web, headless, …).
- Node.js ≥ 20.

## License

[MIT](LICENSE)
