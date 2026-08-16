/**
 * DeepSeek Harness plugin: manage Claude Code-style skills.
 *
 * Registers the model-facing `skill_manager` tool and the human `/skills`
 * slash command over the pure core in `./core.js`. Reads go through the same
 * root precedence as `@deepseek-ai/dsh-skill-filesystem` (whose watcher picks
 * up every mutation this plugin makes), plus the live `ctx.skills` registry
 * for effective/shadowed/registered cross-checks.
 *
 * @module dsh-plugin-skill-manager
 */

import { basename } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import {
	createSkill,
	deleteSkillEntry,
	entriesByName,
	previewBody,
	resolveManagerConfig,
	resolveRoots,
	scanAllRoots,
	updateSkillFile,
} from "./core.js";

export const name = "skill-manager";

export const inject = ["tools", "commands", "skills", "systemPrompt"];

/** @typedef {import("./core.js").ManagerConfig} ManagerConfig */
/** @typedef {import("./core.js").SkillEntry} SkillEntry */

export const Config = z.object({
	dshHome: z.string(),
	agentsHome: z.string(),
	customSkillDirs: z.array(z.string()).default([]),
	defaultScope: z.string().default("user"),
	bodyPreviewChars: z.number().default(600),
});

const ACTIONS = ["list", "inspect", "create", "update", "delete", "validate", "roots"];

const TOOL_DESCRIPTION =
	"Manage this DeepSeek Harness instance's local skill library (Claude Code-style SKILL.md files). " +
	"Actions: `list` every skill across project/user/custom roots with path, format, and invocation status; " +
	"`inspect` one skill's frontmatter and body preview; `create` a new skill (scaffold or full content); " +
	"`update` description/when_to_use/content or invocation toggles in place; `delete` a skill (confirm: true required); " +
	"`validate` the library and report broken skill files the loader silently skips; `roots` show the scanned directories. " +
	"Use whenever the user asks to manage, add, create, edit, enable, disable, remove, share, or fix skills.";

const GUIDANCE =
	"skill_manager manages the local skill library. The available-skills catalog the session advertises is derived from the same files: " +
	"every create/update/delete is picked up immediately, so follow a mutation with list or inspect to confirm. " +
	"disable/enable map to the disable-model-invocation frontmatter key. delete is destructive and requires confirm: true; " +
	"when unsure, inspect first. Prefer the user or project root implied by the user's wording; default is the user root.";

const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: true,
	properties: {
		ok: { type: "boolean", required: true },
		action: { type: "string", required: true },
	},
};

/** Register the tool, its prompt guidance, and the /skills command. */
export function apply(ctx, config = {}) {
	const resolved = resolveManagerConfig({
		dshHome: config.dshHome,
		agentsHome: config.agentsHome,
		customSkillDirs: config.customSkillDirs,
		defaultScope: config.defaultScope === "project" ? "project" : "user",
		bodyPreviewChars: config.bodyPreviewChars,
	});

	const cwdOf = (agent) => agent?.session?.header?.cwd ?? process.cwd();

	/** Scan the library and annotate the live-registry view. */
	async function observe(agent) {
		const cwd = cwdOf(agent);
		const roots = await resolveRoots(resolved, cwd);
		const scan = await scanAllRoots(roots);
		let registered = new Set();
		try {
			const snapshot = await ctx.skills.snapshot({ cwd });
			registered = new Set(snapshot.skills.map((skill) => skill.name));
		} catch (error) {
			ctx.logger.warn(`skill-manager: registry snapshot unavailable: ${error}`);
		}
		for (const entry of scan.entries) {
			entry.registered = entry.name !== undefined && registered.has(entry.name);
		}
		return { cwd, roots, scan };
	}

	/**
	 * Locate every entry for one skill name; throw when nothing declares it.
	 * @param {Awaited<ReturnType<typeof observe>>} observation
	 */
	function requireName(observation, skillName) {
		if (typeof skillName !== "string" || skillName.length === 0) {
			throw new Error("this action requires the skill name");
		}
		const matches = entriesByName(observation.scan.entries, skillName);
		if (matches.length === 0) {
			throw new Error(`no skill named "${skillName}" exists in any scanned root — run action "list" to see names`);
		}
		return matches;
	}

	const tool = defineTool({
		name: "skill_manager",
		description: TOOL_DESCRIPTION,
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: ACTIONS,
				description: "list | inspect | create | update | delete | validate | roots",
			},
			name: {
				type: "string",
				description: "Skill name (kebab-case) for inspect/update/delete/validate.",
			},
			description: {
				type: "string",
				description: "create/update: the skill description shown in catalogs.",
			},
			when_to_use: {
				type: "string",
				description: "create/update: optional usage hint (whenToUse frontmatter).",
			},
			content: {
				type: "string",
				description: "create/update: the full markdown body below the frontmatter; replaces the existing body on update.",
			},
			scope: {
				type: "string",
				enum: ["user", "project"],
				description: `create: installation target. user = ~/.dsh/skills, project = <repo>/.dsh/skills. Default ${resolved.defaultScope}.`,
			},
			model_invocable: {
				type: "boolean",
				description: "create/update: false writes disable-model-invocation: true (hides the skill from the model).",
			},
			user_invocable: {
				type: "boolean",
				description: "create/update: false writes user-invocable: false (hides the skill from human commands).",
			},
			confirm: {
				type: "boolean",
				description: "delete: must be true to remove the skill.",
			},
		},
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: "text", text: renderResult(value, resolved.bodyPreviewChars) }],
		},
		presentCall: (args) => present(`Skill manager: ${args.action}`, args.action, args.name),
		async execute(args, exec) {
			const observation = await observe(exec.agent);
			switch (args.action) {
				case "roots":
					return { ok: true, action: "roots", roots: renderRoots(observation.roots) };
				case "list":
					return { ok: true, action: "list", cwd: observation.cwd, ...renderList(observation) };
				case "inspect": {
					const matches = requireName(observation, args.name);
					return {
						ok: true,
						action: "inspect",
						skills: matches.map((entry) => renderEntry(entry, resolved.bodyPreviewChars)),
					};
				}
				case "validate":
					if (args.name !== undefined) {
						const matches = requireName(observation, args.name);
						return {
							ok: true,
							action: "validate",
							skills: matches.map((entry) => renderEntry(entry, resolved.bodyPreviewChars)),
							problems: matches.flatMap((entry) => entry.problems.map((problem) => `${entry.path}: ${problem}`)),
						};
					}
					return { ok: true, action: "validate", ...renderLibraryProblems(observation) };
				case "create": {
					const existing = typeof args.name === "string" ? entriesByName(observation.scan.entries, args.name) : [];
					if (existing.length > 0) {
						throw new Error(
							`skill "${args.name}" already exists at ${existing[0].path} — use action "update" or "delete" instead`,
						);
					}
					const entry = await createSkill(observation.roots, {
						name: args.name,
						description: args.description,
						whenToUse: args.when_to_use,
						modelInvocation: args.model_invocable,
						userInvocation: args.user_invocable,
						content: args.content,
						scope: args.scope === "project" || args.scope === "user" ? args.scope : resolved.defaultScope,
					});
					return { ok: true, action: "create", skills: [renderEntry(entry, resolved.bodyPreviewChars)] };
				}
				case "update": {
					const matches = requireName(observation, args.name);
					const target = matches[0];
					if (target.problems.length > 0) {
						throw new Error(
							`skill file ${target.path} has problems (${target.problems.join("; ")}) — fix the file or recreate it`,
						);
					}
					const updated = await updateSkillFile(target, {
						description: args.description,
						whenToUse: args.when_to_use,
						modelInvocation: args.model_invocable,
						userInvocation: args.user_invocable,
						content: args.content,
					});
					return { ok: true, action: "update", skills: [renderEntry(updated, resolved.bodyPreviewChars)] };
				}
				case "delete": {
					if (args.confirm !== true) {
						throw new Error(`delete is destructive: re-run with confirm: true to remove skill "${args.name}"`);
					}
					const matches = requireName(observation, args.name);
					const target = matches[0];
					const removal = await deleteSkillEntry(target);
					return {
						ok: true,
						action: "delete",
						name: target.name,
						removed: removal.removed,
						shadowedRemaining: matches.slice(1).map((entry) => entry.path),
					};
				}
				default:
					throw new Error(`unknown action "${args.action}"`);
			}
		},
	});
	ctx.tools.register(tool);

	ctx.systemPrompt.section({
		name: "tool:skill_manager",
		order: 118,
		text: GUIDANCE,
	});

	ctx.commands.register({
		name: "skills",
		description: "Manage the skill library: list, show, create, delete, enable/disable, validate",
		input: { hint: "list | show <name> | create <name> <description> | delete <name> --yes | enable|disable <name> | validate | roots" },
		async handler(invocation) {
			try {
				const text = await runCommand(invocation);
				return { kind: "success", text };
			} catch (error) {
				return { kind: "error", text: String(error) };
			}
		},
	});

	/** Execute one /skills command line. @param {import("@deepseek-ai/dsh-commands").CommandInvocation} invocation */
	async function runCommand(invocation) {
		const tokens = invocation.rawInput.trim().split(/\s+/).filter((token) => token.length > 0);
		const sub = tokens[0] ?? "list";
		const observation = await observe(invocation.agent);
		const name = tokens[1];
		switch (sub) {
			case "list":
			case "ls":
				return renderListText(observation, resolved.bodyPreviewChars);
			case "roots":
				return renderRootsText(observation.roots);
			case "show": {
				if (name === undefined) throw new Error("usage: /skills show <name>");
				const matches = entriesByName(observation.scan.entries, name);
				if (matches.length === 0) throw new Error(`no skill named "${name}" — try /skills list`);
				return matches.map((entry) => renderEntryText(entry, resolved.bodyPreviewChars)).join("\n\n");
			}
			case "create": {
				if (name === undefined || tokens.length < 3) {
					throw new Error("usage: /skills create <kebab-case-name> <one-line description> (then ask the model to fill the body)");
				}
				const existing = entriesByName(observation.scan.entries, name);
				if (existing.length > 0) throw new Error(`skill "${name}" already exists at ${existing[0].path}`);
				const entry = await createSkill(observation.roots, {
					name,
					description: tokens.slice(2).join(" "),
					scope: resolved.defaultScope,
				});
				return `Created ${entry.path}\nAsk the model to fill the body, e.g. "update skill ${name} with instructions for …".`;
			}
			case "delete": {
				const confirmed = tokens.includes("-y") || tokens.includes("--yes");
				const targetName = tokens.slice(1).find((token) => token !== "-y" && token !== "--yes");
				if (targetName === undefined) throw new Error("usage: /skills delete <name> --yes");
				if (!confirmed) throw new Error(`refusing to delete "${targetName}" without --yes`);
				const matches = entriesByName(observation.scan.entries, targetName);
				if (matches.length === 0) throw new Error(`no skill named "${targetName}" — try /skills list`);
				const removal = await deleteSkillEntry(matches[0]);
				return `Removed:\n${removal.removed.map((path) => `- ${path}`).join("\n")}`;
			}
			case "enable":
			case "disable": {
				if (name === undefined) throw new Error(`usage: /skills ${sub} <name>`);
				const matches = entriesByName(observation.scan.entries, name);
				if (matches.length === 0) throw new Error(`no skill named "${name}" — try /skills list`);
				const updated = await updateSkillFile(matches[0], { modelInvocation: sub === "enable" });
				return `${sub === "enable" ? "Enabled" : "Disabled"} ${name} (${updated.path})`;
			}
			case "validate": {
				const problems = renderLibraryProblems(observation);
				if (problems.problems.length === 0 && problems.rootErrors.length === 0 && problems.ignored.length === 0) {
					return `All ${observation.scan.entries.length} skill file(s) across ${observation.roots.length} roots are valid.`;
				}
				return renderLibraryProblemsText(problems);
			}
			case "help":
			default:
				return [
					"/skills — manage the local skill library",
					"",
					"  /skills list                    show all skills with status and paths",
					"  /skills show <name>             frontmatter + body preview",
					"  /skills create <name> <desc…>   scaffold a skill (body empty; ask the model to fill it)",
					"  /skills delete <name> --yes     remove a skill permanently",
					"  /skills enable|disable <name>   toggle model invocation",
					"  /skills validate                check every skill file",
					"  /skills roots                   show scanned directories",
				].join("\n");
		}
	}
}

/** @param {string} title @param {string} kind @param {string | undefined} rawInput */
function present(title, kind, rawInput) {
	return {
		card: "generic",
		title,
		kind: kind === "list" || kind === "inspect" || kind === "validate" || kind === "roots" ? "read" : "write",
		...(rawInput === undefined ? {} : { rawInput }),
	};
}

/** @param {import("./core.js").SkillRoot[]} roots */
function renderRoots(roots) {
	return roots.map((root) => ({ source: root.source, rank: root.rank, scope: root.scope, path: root.path }));
}

/** @param {import("./core.js").SkillRoot[]} roots */
function renderRootsText(roots) {
	return ["Scanned skill roots (precedence order):", ...roots.map((root) => `- ${root.source} (rank ${root.rank}): ${root.path}`)].join("\n");
}

/**
 * Summarize the library for the tool result.
 * @param {Awaited<ReturnType<typeof observe>>} observation
 */
function renderList(observation) {
	const { scan } = observation;
	return {
		total: scan.entries.length,
		valid: scan.entries.filter((entry) => entry.valid).length,
		skills: scan.entries.map((entry) => summarize(entry)),
		ignored: scan.ignored,
		rootErrors: scan.rootErrors,
	};
}

/** @param {SkillEntry} entry */
function summarize(entry) {
	return {
		name: entry.name,
		description: entry.description,
		whenToUse: entry.whenToUse,
		path: entry.path,
		format: entry.format,
		source: entry.root.source,
		rank: entry.root.rank,
		invocation: entry.invocation,
		valid: entry.valid,
		effective: entry.effective,
		registered: entry.registered,
		problems: entry.problems,
	};
}

/** @param {SkillEntry} entry @param {number} previewChars */
function renderEntry(entry, previewChars) {
	return {
		...summarize(entry),
		metadata: entry.metadata,
		bodyPreview: previewBody(entry.body, previewChars),
	};
}

/** @param {SkillEntry} entry @param {number} previewChars */
function renderEntryText(entry, previewChars) {
	const source = entry.source ?? entry.root?.source ?? "unknown";
	const status = [
		entry.valid ? "valid" : `invalid (${(entry.problems ?? []).join("; ")})`,
		entry.effective === false ? "shadowed by a higher-precedence skill" : "effective",
		entry.registered === false ? "not in live registry" : "in live registry",
		entry.invocation ? `model: ${entry.invocation.modelInvocable ? "on" : "off"}, user: ${entry.invocation.userInvocable ? "on" : "off"}` : "invocation: unknown",
	].join(" · ");
	return [`## ${entry.name ?? basename(entry.path)} (${entry.format}, ${source})`, status, `Path: ${entry.path}`, "", previewBody(entry.body, previewChars)].join("\n");
}

/** @param {Awaited<ReturnType<typeof observe>>} observation @param {number} previewChars */
function renderListText(observation, previewChars) {
	const { scan } = observation;
	const lines = [`# Skills (${scan.entries.length} file(s), ${scan.entries.filter((entry) => entry.valid).length} valid)`];
	for (const entry of scan.entries) {
		const flags = [
			entry.format,
			entry.root.source,
			entry.invocation ? (entry.invocation.modelInvocable ? "model:on" : "model:off") : "?",
			entry.effective === false ? "SHADOWED" : null,
			entry.registered === false ? "unregistered" : null,
			entry.valid ? null : "INVALID",
		].filter((flag) => flag !== null);
		lines.push(`- ${entry.name ?? basename(entry.path)} — ${entry.description ?? "(no description)"} [${flags.join(", ")}]`);
		lines.push(`    ${entry.path}`);
	}
	const problems = renderLibraryProblems(observation);
	if (problems.problems.length > 0 || problems.rootErrors.length > 0 || problems.ignored.length > 0) {
		lines.push("", renderLibraryProblemsText(problems));
	}
	return lines.join("\n");
}

/**
 * Collect library-wide diagnostics.
 * @param {Awaited<ReturnType<typeof observe>>} observation
 */
function renderLibraryProblems(observation) {
	const { scan } = observation;
	return {
		problems: scan.entries.flatMap((entry) => entry.problems.map((problem) => `${entry.path}: ${problem}`)),
		ignored: scan.ignored,
		rootErrors: scan.rootErrors,
	};
}

/** @param {ReturnType<typeof renderLibraryProblems>} problems */
function renderLibraryProblemsText(problems) {
	const lines = [];
	if (problems.problems.length > 0) {
		lines.push("Invalid skill files:");
		lines.push(...problems.problems.map((problem) => `- ${problem}`));
	}
	if (problems.ignored.length > 0) {
		lines.push("Ignored entries (no SKILL.md):");
		lines.push(...problems.ignored.map((item) => `- ${item.path} (${item.reason})`));
	}
	if (problems.rootErrors.length > 0) {
		lines.push("Root errors:");
		lines.push(...problems.rootErrors.map((item) => `- ${item.root}: ${item.error}`));
	}
	return lines.length > 0 ? lines.join("\n") : "No problems found.";
}

/** Render the structured tool value as readable markdown text. @param {Record<string, unknown>} value */
function renderResult(value, previewChars) {
	if (value.ok !== true) return JSON.stringify(value);
	switch (value.action) {
		case "list": {
			const skills = value.skills ?? [];
			const lines = [`# Skills (${value.total ?? skills.length} file(s), ${value.valid ?? "?"} valid)`];
			for (const entry of skills) {
				const flags = [
					entry.format,
					entry.source,
					entry.invocation ? (entry.invocation.modelInvocable ? "model:on" : "model:off") : "?",
					entry.effective === false ? "SHADOWED" : null,
					entry.registered === false ? "unregistered" : null,
					entry.valid ? null : `INVALID: ${(entry.problems ?? []).join("; ")}`,
				].filter((flag) => flag !== null);
				lines.push(`- ${entry.name}: ${entry.description ?? ""} [${flags.join(", ")}]`);
				lines.push(`    ${entry.path}`);
			}
			for (const problem of value.rootErrors ?? []) lines.push(`- root error: ${problem.root}: ${problem.error}`);
			return lines.join("\n");
		}
		case "inspect":
		case "create":
		case "update":
			return (value.skills ?? [])
				.map((entry) => renderEntryText(entry, previewChars))
				.join("\n\n");
		default:
			return JSON.stringify(value, null, 2);
	}
}

export { ACTIONS as SKILL_MANAGER_ACTIONS };

export default { name, inject, Config, apply };
