# dsh-plugin-skill-manager

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，用来管理你的 **skills** —— 也就是 Claude Code 那种 `SKILL.md` 指令文件，DSH 会从项目目录和用户目录加载它们。

它在任何基于 `@deepseek-ai/dsh-base` 的 DSH profile 上提供两个入口：

- **`skill_manager` 工具** —— 模型可以在对话中直接列出、查看、创建、更新、删除、校验、启用/禁用 skill。
- **`/skills` 命令** —— 你在聊天输入框里就能管理同一个库，不消耗任何 token。

本插件写出的每一个文件都严格遵循 [`@deepseek-ai/dsh-skill-filesystem`](https://www.npmjs.com/package/@deepseek-ai/dsh-skill-filesystem) 的发现契约（相同的根目录、相同的优先级、相同的 frontmatter 字段），因此改动会在文件 watcher 的稳定窗口内被实时 skill 注册表感知——会话的可用技能目录无需重启即会更新。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-skill-manager
```

然后重启 profile（`dsh web`）。其他 profile 用法相同。安装指定版本或 git 检出：

```sh
dsh plugin --profile web add dsh-plugin-skill-manager@0.1.0
dsh plugin --profile web add github:user/dsh-plugin-skill-manager
```

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-skill-manager
```

## 管理范围

与官方 filesystem provider 相同的根目录、相同的优先级顺序：

| 优先级 | 来源 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<项目根>/.dsh/skills` |
| 200 | `project-agents` | `<项目根>/.agents/skills` |
| 300 | `custom` | 配置的 `customSkillDirs` |
| 400 | `user-dsh` | `~/.dsh/skills` |
| 500 | `user-agents` | `~/.agents/skills` |

技能可以是 `<name>/SKILL.md` 目录束，也可以是单个 `<name>.md` 文件，frontmatter 格式：

```yaml
---
name: my-skill
description: 这个技能做什么，会显示在目录里。
whenToUse: 可选的额外路由提示。
disable-model-invocation: false   # true 表示对模型隐藏
user-invocable: true              # false 表示对人类命令隐藏
---
技能被调用时模型逐字阅读的正文指令。
```

`name` + `description` 必填；`whenToUse`、`metadata` 和两个 invocation 键都是可选的（插件只在需要限制时才写 invocation 键，默认文件保持 Claude Code 原生格式）。

## `skill_manager` 工具

| 动作 | 关键参数 | 说明 |
|---|---|---|
| `list` | — | 列出所有根里的全部技能文件：路径、格式、来源、调用状态，以及被遮蔽副本和实时注册表标记。 |
| `inspect` | `name` | 显示声明该名称的每个条目的完整 frontmatter 和正文预览。 |
| `create` | `name`、`description`、`content?`、`scope?`（`user` \| `project`）、`when_to_use?`、`model_invocable?`、`user_invocable?` | 脚手架一个合法技能（拒绝覆盖已有名称）。默认 scope 来自配置。 |
| `update` | `name` + `description?` / `when_to_use?` / `content?` / `model_invocable?` / `user_invocable?` 任意组合 | 原地合并 frontmatter，保留未知字段；只有给出 `content` 时才替换正文。 |
| `delete` | `name`、`confirm: true` | 删除目录束或扁平文件。必须显式传 `confirm`。 |
| `validate` | `name?` | 报告加载器会静默跳过的坏技能文件（YAML 错误、缺字段、非法名称），以及被忽略的目录和不可读的根。 |
| `roots` | — | 解析出的根目录列表（含优先级）。 |

示例——在 DSH 会话里对模型说：

> 用 skill_manager 建一个 skill：名字 `pdf-report`，描述"生成 PDF 周报"，正文按我们刚讨论的模板写。

## `/skills` 命令

完全运行在 UI 命令面板（输出不进入模型历史）：

```text
/skills                              # 列出全部技能及状态
/skills show pdf-report              # frontmatter + 正文预览
/skills create pdf-report 生成 PDF 周报  # 先脚手架，再让模型填正文
/skills disable pdf-report           # 对模型隐藏（写 disable-model-invocation: true）
/skills enable pdf-report
/skills delete pdf-report --yes      # 永久删除；必须带 --yes
/skills validate                     # 检查所有技能文件
/skills roots                        # 显示扫描的目录
```

## 配置

在 profile 的 `cordis.patch.yml` 里给行加 `config`（`dsh plugin` 安装时使用默认值，无需配置即可用）：

```yaml
- id: skill-manager
  config:
    defaultScope: user        # /skills create 和不带 scope 的 create 放在哪里
    bodyPreviewChars: 600      # inspect/show 输出的预览长度
    customSkillDirs: []        # 额外根目录，优先级 300
    # dshHome / agentsHome 可覆盖 $DSH_HOME / $DSH_AGENTS_HOME
```

## 设计说明

- **读取时交叉核对实时注册表。** `list` 为每个条目标注 `ctx.skills` 注册表当前是否提供它，被遮蔽的副本（例如项目技能覆盖了用户技能）一眼可见。
- **删除有防护。** `delete` 只接受插件自己扫描发现的名称——绝不接受调用方提供的路径——删除前重新读取目标，文件声明的名称与扫描时不一致则拒绝。
- **诊断优先于沉默。** 官方 provider 对畸形条目只打日志；`validate` 把它们连同确切原因一起呈现。
- **零构建。** 纯 ESM JavaScript；`npm test` 运行单元与集成套件（集成套件会用真实的 dsh 服务启动一个真实 cordis 上下文）。

## 兼容性

- DeepSeek Harness `@deepseek-ai/dsh` `0.1.0-rc.x`，基于 `dsh-base` 的 profile（web、headless 等）。
- Node.js ≥ 20。

## 许可证

[MIT](LICENSE)
