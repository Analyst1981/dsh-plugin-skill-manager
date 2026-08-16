/**
 * Pure skill-file management core for dsh-plugin-skill-manager.
 *
 * Mirrors the local discovery contract of `@deepseek-ai/dsh-skill-filesystem`
 * (root precedence, SKILL.md bundle/flat formats, YAML frontmatter fields, and
 * invocation policy keys) so every file this module writes is immediately
 * visible to the shipped filesystem skill provider, and adds the management
 * operations that provider deliberately does not have: diagnostics for broken
 * entries, shadow-duplicate detection, create/update/delete.
 *
 * This module has no cordis or dsh imports; it runs on plain Node promises so
 * it stays unit-testable and reusable from any host.
 *
 * @module dsh-plugin-skill-manager/core
 */

import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";

/** Public kebab-case skill-name grammar shared with the dsh skill registry. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a string is a valid kebab-case skill name.
 * @param {unknown} name - candidate skill name.
 * @returns {boolean}
 */
export function isSkillName(name) {
	return typeof name === "string" && SKILL_NAME_PATTERN.test(name);
}

/** Root precedence ranks mirrored from dsh-skill-filesystem. */
export const ROOT_RANKS = Object.freeze({
	PROJECT_DSH: 100,
	PROJECT_AGENTS: 200,
	CUSTOM: 300,
	USER_DSH: 400,
	USER_AGENTS: 500,
});

/**
 * @typedef {Object} ManagerConfig
 * @property {string} dshHome
 * @property {string} agentsHome
 * @property {string[]} customSkillDirs
 * @property {"user" | "project"} defaultScope
 * @property {number} bodyPreviewChars
 */

/**
 * Normalize plugin configuration with the same environment fallbacks the
 * shipped filesystem provider uses.
 * @param {Partial<ManagerConfig>} [overrides]
 * @returns {ManagerConfig}
 */
export function resolveManagerConfig(overrides = {}) {
	const dshHome = nonEmpty(overrides.dshHome) ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const agentsHome = nonEmpty(overrides.agentsHome) ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), ".agents");
	const customSkillDirs = (Array.isArray(overrides.customSkillDirs) ? overrides.customSkillDirs : [])
		.filter((value) => typeof value === "string" && value.length > 0)
		.map(expandHome);
	const defaultScope = overrides.defaultScope === "project" ? "project" : "user";
	const preview = overrides.bodyPreviewChars;
	const bodyPreviewChars = typeof preview === "number" && Number.isSafeInteger(preview) && preview >= 100 ? preview : 600;
	return { dshHome, agentsHome, customSkillDirs, defaultScope, bodyPreviewChars };
}

/** Return the string when non-empty, else undefined. */
function nonEmpty(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Expand a leading `~` against the OS home directory. */
export function expandHome(path) {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

/** @param {string} path */
async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Nearest ancestor of `cwd` containing `.git`; the cwd itself when none exists
 * (same fallback as the shipped provider).
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export async function findProjectRoot(cwd) {
	let current = resolve(cwd);
	while (true) {
		if (await pathExists(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

/**
 * @typedef {Object} SkillRoot
 * @property {string} path
 * @property {"project-dsh" | "project-agents" | "custom" | "user-dsh" | "user-agents"} source
 * @property {number} rank
 * @property {"project" | "user" | "custom"} scope
 * @property {boolean} [skipSystem]
 */

/**
 * Resolve the managed skill roots in precedence order for one workspace.
 * @param {ManagerConfig} config
 * @param {string | undefined} cwd - workspace root; project roots resolve only when supplied.
 * @returns {Promise<SkillRoot[]>}
 */
export async function resolveRoots(config, cwd) {
	/** @type {SkillRoot[]} */
	const roots = [];
	if (cwd !== undefined) {
		const projectRoot = await findProjectRoot(resolve(cwd));
		roots.push({
			path: join(projectRoot, ".dsh", "skills"),
			source: "project-dsh",
			rank: ROOT_RANKS.PROJECT_DSH,
			scope: "project",
		});
		roots.push({
			path: join(projectRoot, ".agents", "skills"),
			source: "project-agents",
			rank: ROOT_RANKS.PROJECT_AGENTS,
			scope: "project",
		});
	}
	for (const dir of config.customSkillDirs) {
		roots.push({ path: dir, source: "custom", rank: ROOT_RANKS.CUSTOM, scope: "custom" });
	}
	roots.push({
		path: join(config.dshHome, "skills"),
		source: "user-dsh",
		rank: ROOT_RANKS.USER_DSH,
		scope: "user",
		skipSystem: true,
	});
	roots.push({
		path: join(config.agentsHome, "skills"),
		source: "user-agents",
		rank: ROOT_RANKS.USER_AGENTS,
		scope: "user",
	});
	return roots;
}

/**
 * Parse YAML frontmatter with the exact framing algorithm of the shipped
 * provider. Returns undefined when the file has no frontmatter block; throws
 * when the YAML inside the block is invalid.
 * @param {string} raw
 * @returns {{ data: Record<string, unknown>, body: string } | undefined}
 */
export function parseFrontmatter(raw) {
	const firstLineEnd = raw.indexOf("\n");
	if (firstLineEnd < 0) return undefined;
	if (raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") return undefined;
	const start = firstLineEnd + 1;
	const closing = findClosingFrontmatter(raw, start);
	if (closing === undefined) return undefined;
	const data = parse(raw.slice(start, closing.start));
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	return { data, body: raw.slice(closing.bodyStart) };
}

/** @param {string} raw @param {number} start */
function findClosingFrontmatter(raw, start) {
	let lineStart = start;
	while (lineStart <= raw.length) {
		const nextNewline = raw.indexOf("\n", lineStart);
		const lineEnd = nextNewline < 0 ? raw.length : nextNewline;
		if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
			return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 };
		}
		if (nextNewline < 0) return undefined;
		lineStart = nextNewline + 1;
	}
	return undefined;
}

/** Frontmatter field order this manager writes on create and rewrite. */
const FRONTMATTER_FIELD_ORDER = [
	"name",
	"description",
	"whenToUse",
	"metadata",
	"disable-model-invocation",
	"user-invocable",
];

/**
 * Serialize one skill file: `---` block with ordered known keys (unknown
 * original keys preserved after them), exactly one blank line, then the body
 * with a single trailing newline.
 * @param {Record<string, unknown>} data
 * @param {string} body
 * @returns {string}
 */
export function serializeSkillFile(data, body) {
	const ordered = {};
	for (const key of FRONTMATTER_FIELD_ORDER) {
		if (Object.hasOwn(data, key) && data[key] !== undefined) ordered[key] = data[key];
	}
	for (const key of Object.keys(data)) {
		if (!Object.hasOwn(ordered, key) && data[key] !== undefined) ordered[key] = data[key];
	}
	const frontmatter = stringify(ordered).trimEnd();
	const normalizedBody = `${body.replace(/^[\r\n]+/, "").replace(/\s+$/, "")}\n`;
	return `---\n${frontmatter}\n---\n\n${normalizedBody}`;
}

/**
 * @typedef {Object} SkillEntry
 * @property {string | undefined} name - frontmatter name once parsed and present.
 * @property {string | undefined} description
 * @property {string | undefined} whenToUse
 * @property {{ modelInvocable: boolean, userInvocable: boolean } | undefined} invocation
 * @property {Record<string, unknown> | undefined} metadata
 * @property {string} path - absolute path of the SKILL.md / flat file.
 * @property {string} directory - owning directory (bundle dir or the root for flat).
 * @property {"bundle" | "flat"} format
 * @property {SkillRoot} root
 * @property {string[]} problems - diagnostics; empty when the entry is fully valid.
 * @property {boolean} valid
 * @property {string} body - raw body below the frontmatter.
 * @property {boolean} [effective] - whether this entry wins its name across roots.
 * @property {boolean} [registered] - whether the live skill registry currently lists this name.
 */

/**
 * @typedef {Object} RootScan
 * @property {SkillEntry[]} skills
 * @property {{ path: string, reason: string }[]} ignored
 * @property {string | undefined} rootError
 */

/**
 * Scan one root: every `<name>/SKILL.md` bundle and flat `<name>.md` file,
 * keeping diagnostic problems instead of silently skipping like the shipped
 * provider does.
 * @param {SkillRoot} root
 * @returns {Promise<RootScan>}
 */
export async function scanRoot(root) {
	/** @type {import("node:fs").Dirent[]} */
	let entries;
	try {
		entries = await readdir(root.path, { withFileTypes: true });
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
			return { skills: [], ignored: [], rootError: undefined };
		}
		return { skills: [], ignored: [], rootError: `cannot read root: ${errorMessage(error)}` };
	}
	/** @type {SkillEntry[]} */
	const skills = [];
	/** @type {{ path: string, reason: string }[]} */
	const ignored = [];
	for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		if (root.skipSystem === true && entry.name === ".system") continue;
		if (entry.isDirectory()) {
			const skillPath = join(root.path, entry.name, "SKILL.md");
			if (!(await pathExists(skillPath))) {
				ignored.push({
					path: join(root.path, entry.name),
					reason: "directory has no SKILL.md (nested bundles are not discovered)",
				});
				continue;
			}
			skills.push(await readCandidate(skillPath, join(root.path, entry.name), "bundle", root));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			skills.push(await readCandidate(join(root.path, entry.name), root.path, "flat", root));
		}
	}
	return { skills, ignored, rootError: undefined };
}

/**
 * Read and diagnose one candidate skill file.
 * @param {string} path @param {string} directory @param {"bundle" | "flat"} format @param {SkillRoot} root
 * @returns {Promise<SkillEntry>}
 */
async function readCandidate(path, directory, format, root) {
	/** @type {SkillEntry} */
	const entry = { path, directory, format, root, problems: [], valid: false, body: "", name: undefined, description: undefined, whenToUse: undefined, invocation: undefined, metadata: undefined };
	let raw;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		entry.problems.push(`unreadable file: ${errorMessage(error)}`);
		return entry;
	}
	let parsed;
	try {
		parsed = parseFrontmatter(raw);
	} catch (error) {
		entry.problems.push(`invalid YAML frontmatter: ${errorMessage(error)}`);
		return entry;
	}
	if (parsed === undefined) {
		entry.problems.push("missing YAML frontmatter (file must start with a `---` block declaring name and description)");
		return entry;
	}
	entry.body = parsed.body;
	const data = parsed.data;
	const name = stringField(data, "name");
	const description = stringField(data, "description");
	if (name === undefined || description === undefined) {
		entry.problems.push("frontmatter requires non-empty name and description");
	} else {
		entry.name = name;
		entry.description = description;
		if (!isSkillName(name)) entry.problems.push(`invalid skill name "${name}" (must match ${SKILL_NAME_PATTERN})`);
	}
	try {
		entry.invocation = parseInvocationPolicy(data);
	} catch (error) {
		entry.problems.push(errorMessage(error));
	}
	const whenToUse = stringField(data, "whenToUse");
	if (whenToUse !== undefined) entry.whenToUse = whenToUse;
	const metadataValue = data.metadata;
	if (typeof metadataValue === "object" && metadataValue !== null && !Array.isArray(metadataValue)) {
		entry.metadata = /** @type {Record<string, unknown>} */ (metadataValue);
	}
	entry.valid = entry.problems.length === 0;
	return entry;
}

/** @param {Record<string, unknown>} data @param {string} key */
function stringField(data, key) {
	const value = data[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Invocation policy from frontmatter, mirroring the shipped provider's
 * canonical keys and accepted boolean spellings.
 * @param {Record<string, unknown>} data
 * @returns {{ modelInvocable: boolean, userInvocable: boolean }}
 */
export function parseInvocationPolicy(data) {
	for (const legacy of ["disableModelInvocation", "modelInvocable", "userInvocable"]) {
		if (Object.hasOwn(data, legacy)) {
			const canonical = legacy === "userInvocable" ? "user-invocable" : "disable-model-invocation";
			throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`);
		}
	}
	const disableModelInvocation = frontmatterBoolean(data, "disable-model-invocation");
	const userInvocable = frontmatterBoolean(data, "user-invocable");
	return {
		modelInvocable: disableModelInvocation !== true,
		userInvocable: userInvocable !== false,
	};
}

/** @param {Record<string, unknown>} data @param {string} key */
function frontmatterBoolean(data, key) {
	if (!Object.hasOwn(data, key)) return undefined;
	const value = data[key];
	if (typeof value === "boolean") return value;
	if (value === 1 || value === "1") return true;
	if (value === 0 || value === "0") return false;
	if (typeof value === "string") {
		switch (value.toLowerCase()) {
			case "true":
			case "yes":
			case "on": return true;
			case "false":
			case "no":
			case "off": return false;
		}
	}
	throw new TypeError(`frontmatter field "${key}" must be a boolean`);
}

/**
 * @typedef {Object} LibraryScan
 * @property {SkillEntry[]} entries - every candidate in root precedence order.
 * @property {{ path: string, reason: string, root: string }[]} ignored
 * @property {{ root: string, error: string }[]} rootErrors
 */

/**
 * Scan every root and mark which entries win their name (the effective entry
 * the skill registry serves) versus shadowed duplicates.
 * @param {SkillRoot[]} roots - in precedence order, as resolveRoots returns.
 * @returns {Promise<LibraryScan>}
 */
export async function scanAllRoots(roots) {
	/** @type {SkillEntry[]} */
	const entries = [];
	/** @type {{ path: string, reason: string, root: string }[]} */
	const ignored = [];
	/** @type {{ root: string, error: string }[]} */
	const rootErrors = [];
	for (const root of roots) {
		const scan = await scanRoot(root);
		if (scan.rootError !== undefined) rootErrors.push({ root: root.path, error: scan.rootError });
		for (const item of scan.ignored) ignored.push({ ...item, root: root.path });
		entries.push(...scan.skills);
	}
	const seen = new Set();
	for (const entry of entries) {
		if (entry.name === undefined || !entry.valid) continue;
		if (seen.has(entry.name)) entry.effective = false;
		else {
			entry.effective = true;
			seen.add(entry.name);
		}
	}
	return { entries, ignored, rootErrors };
}

/**
 * Body text used when creating a skill without explicit content.
 * @param {string} name @param {string} description
 * @returns {string}
 */
export function defaultSkillBody(name, description) {
	return [
		`# ${name}`,
		"",
		`${description}`,
		"",
		"## Instructions",
		"",
		"Describe when to use this skill and the exact steps to follow. Keep the body",
		"self-contained: the model reads this file verbatim when the skill is invoked.",
		"",
		"## Notes",
		"",
		"- Reference bundled resources (scripts, templates, assets) by path relative to",
		"  this skill's directory.",
		"- Prefer concrete, imperative guidance over generic advice.",
		"",
	].join("\n");
}

/**
 * @typedef {Object} CreateSkillInput
 * @property {string} name
 * @property {string} description
 * @property {string} [whenToUse]
 * @property {Record<string, unknown>} [metadata]
 * @property {boolean} [modelInvocation]
 * @property {boolean} [userInvocation]
 * @property {string} [content]
 * @property {"user" | "project"} scope
 * @property {"bundle" | "flat"} [format]
 */

/**
 * Create one skill file in the selected scope's canonical root.
 * @param {SkillRoot[]} roots
 * @param {CreateSkillInput} input
 * @returns {Promise<SkillEntry & { created: true }>}
 */
export async function createSkill(roots, input) {
	if (!isSkillName(input.name)) throw new Error(`invalid skill name "${input.name}" (must match ${SKILL_NAME_PATTERN})`);
	if (typeof input.description !== "string" || input.description.trim().length === 0) {
		throw new Error("create requires a non-empty description");
	}
	const target = roots.find((root) => (input.scope === "project" ? root.source === "project-dsh" : root.source === "user-dsh"));
	if (target === undefined) throw new Error("project scope requires a workspace with a resolvable project root");
	const format = input.format === "flat" ? "flat" : "bundle";
	const directory = format === "bundle" ? join(target.path, input.name) : target.path;
	const path = format === "bundle" ? join(directory, "SKILL.md") : join(target.path, `${input.name}.md`);
	if (await pathExists(path)) throw new Error(`skill file already exists: ${path}`);
	if (format === "bundle" && directory !== target.path && await pathExists(directory)) {
		throw new Error(`skill directory already exists: ${directory}`);
	}
	await mkdir(directory, { recursive: true });
	const data = {
		name: input.name,
		description: input.description.trim(),
	};
	if (input.whenToUse !== undefined && input.whenToUse.length > 0) data.whenToUse = input.whenToUse;
	if (input.metadata !== undefined) data.metadata = input.metadata;
	if (input.modelInvocation === false) data["disable-model-invocation"] = true;
	if (input.userInvocation === false) data["user-invocable"] = false;
	const body = (input.content ?? defaultSkillBody(input.name, input.description)).trim();
	await writeFile(path, serializeSkillFile(data, body), "utf8");
	const entry = await readCandidate(path, directory, format, target);
	if (!entry.valid) {
		await rm(format === "bundle" ? directory : path, { recursive: true, force: true }).catch(() => {});
		throw new Error(`created file failed validation: ${entry.problems.join("; ")}`);
	}
	return { ...entry, created: true };
}

/**
 * @typedef {Object} UpdateSkillInput
 * @property {string} [description]
 * @property {string | null} [whenToUse] - null clears the field.
 * @property {Record<string, unknown> | null} [metadata] - null clears the field.
 * @property {boolean} [modelInvocation]
 * @property {boolean} [userInvocation]
 * @property {string} [content] - full replacement body.
 */

/**
 * Rewrite one skill file with merged frontmatter and optional body
 * replacement, preserving unknown frontmatter keys.
 * @param {SkillEntry} entry - target located by scan.
 * @param {UpdateSkillInput} patches
 * @returns {Promise<SkillEntry>} the refreshed entry.
 */
export async function updateSkillFile(entry, patches) {
	let raw;
	try {
		raw = await readFile(entry.path, "utf8");
	} catch (error) {
		throw new Error(`cannot read ${entry.path}: ${errorMessage(error)}`);
	}
	let parsed;
	try {
		parsed = parseFrontmatter(raw);
	} catch (error) {
		throw new Error(`cannot update ${entry.path}: invalid YAML frontmatter: ${errorMessage(error)}`);
	}
	if (parsed === undefined) {
		throw new Error(`cannot update ${entry.path}: file has no YAML frontmatter (recreate it instead)`);
	}
	const data = { ...parsed.data };
	if (patches.description !== undefined) {
		if (typeof patches.description !== "string" || patches.description.trim().length === 0) {
			throw new Error("description must be a non-empty string");
		}
		data.description = patches.description.trim();
	}
	if (patches.whenToUse !== undefined) {
		if (patches.whenToUse === null || patches.whenToUse === "") delete data.whenToUse;
		else data.whenToUse = patches.whenToUse;
	}
	if (patches.metadata !== undefined) {
		if (patches.metadata === null) delete data.metadata;
		else data.metadata = patches.metadata;
	}
	if (patches.modelInvocation !== undefined) {
		if (patches.modelInvocation === false) data["disable-model-invocation"] = true;
		else delete data["disable-model-invocation"];
	}
	if (patches.userInvocation !== undefined) {
		if (patches.userInvocation === false) data["user-invocable"] = false;
		else delete data["user-invocable"];
	}
	const body = patches.content !== undefined ? patches.content : parsed.body;
	await writeFile(entry.path, serializeSkillFile(data, body), "utf8");
	return readCandidate(entry.path, entry.directory, entry.format, entry.root);
}

/**
 * Delete one scanned entry: the whole bundle directory for bundle skills, the
 * single file for flat skills.
 * @param {SkillEntry} entry
 * @returns {Promise<{ removed: string[] }>}
 */
export async function deleteSkillEntry(entry) {
	if (entry.format === "bundle") {
		// Guard against a stale scan: re-read before removing the directory.
		const current = await readCandidate(entry.path, entry.directory, entry.format, entry.root);
		if (current.name !== undefined && entry.name !== undefined && current.name !== entry.name) {
			throw new Error(`refusing to delete: ${entry.path} now declares skill "${current.name}", not "${entry.name}" — rescan first`);
		}
		await rm(entry.directory, { recursive: true, force: false });
		return { removed: [entry.directory] };
	}
	await rm(entry.path, { force: false });
	return { removed: [entry.path] };
}

/** @param {string} body @param {number} limit */
export function previewBody(body, limit) {
	const text = body.trim();
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}

/**
 * Find every entry declaring one skill name, effective first.
 * @param {SkillEntry[]} entries
 * @param {string} name
 * @returns {SkillEntry[]}
 */
export function entriesByName(entries, name) {
	return entries
		.filter((entry) => entry.name === name)
		.sort((a, b) => Number(b.effective ?? false) - Number(a.effective ?? false) || a.root.rank - b.root.rank);
}

/** Human-safe message for any thrown value. */
function errorMessage(error) {
	try {
		return String(error);
	} catch {
		return "[unrenderable thrown value]";
	}
}
