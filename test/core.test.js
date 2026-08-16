/**
 * Unit tests for the pure core: frontmatter round-trips, root precedence,
 * discovery diagnostics, CRUD, and shadow detection.
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	SKILL_NAME_PATTERN,
	createSkill,
	deleteSkillEntry,
	entriesByName,
	isSkillName,
	parseFrontmatter,
	resolveManagerConfig,
	resolveRoots,
	scanAllRoots,
	serializeSkillFile,
	updateSkillFile,
} from "../lib/core.js";

/** @param {string} dir */
async function tempDir(dir) {
	return mkdtemp(join(tmpdir(), "dsh-skill-manager-"));
}

test("isSkillName accepts kebab-case only", () => {
	assert.equal(isSkillName("my-skill"), true);
	assert.equal(isSkillName("my-skill-2"), true);
	assert.equal(isSkillName("My-Skill"), false);
	assert.equal(isSkillName("my_skill"), false);
	assert.equal(isSkillName("-my-skill"), false);
	assert.equal(isSkillName("../escape"), false);
	assert.equal(SKILL_NAME_PATTERN.test("a"), true);
});

test("parseFrontmatter matches the shipped provider framing", () => {
	assert.equal(parseFrontmatter("no frontmatter here"), undefined);
	assert.equal(parseFrontmatter("---\nname: x\n(no closing)"), undefined);
	assert.equal(parseFrontmatter("---\n- just\n- a list\n---\nbody"), undefined);
	const parsed = parseFrontmatter("---\nname: demo\ndescription: A demo skill\n---\n\nBody text\n");
	assert.deepEqual(parsed.data, { name: "demo", description: "A demo skill" });
	assert.equal(parsed.body, "\nBody text\n");
});

test("parseFrontmatter throws on invalid YAML", () => {
	assert.throws(() => parseFrontmatter("---\nname: [unclosed\n---\nbody"));
});

test("serializeSkillFile round-trips and normalizes whitespace", () => {
	const text = serializeSkillFile({ name: "demo", description: "A demo" }, "\n\nSome body\n\n\n");
	assert.match(text, /^---\nname: demo\ndescription: A demo\n---\n\nSome body\n$/);
	const reparsed = parseFrontmatter(text);
	assert.deepEqual(reparsed.data, { name: "demo", description: "A demo" });
	assert.equal(reparsed.body, "\nSome body\n");
});

test("serializeSkillFile writes invocation keys only for restrictive values", () => {
	const off = serializeSkillFile({ name: "n", description: "d", "disable-model-invocation": true, "user-invocable": false }, "b");
	assert.match(off, /disable-model-invocation: true/);
	assert.match(off, /user-invocable: false/);
	const on = serializeSkillFile({ name: "n", description: "d" }, "b");
	assert.doesNotMatch(on, /invocation/);
});

test("resolveRoots mirrors provider precedence and config fallbacks", async () => {
	const home = await tempDir();
	const custom = join(home, "extra-skills");
	const config = resolveManagerConfig({
		dshHome: join(home, "dsh"),
		agentsHome: join(home, "agents"),
		customSkillDirs: [custom],
	});
	const roots = await resolveRoots(config, join(home, "repo"));
	assert.deepEqual(
		roots.map((root) => root.source),
		["project-dsh", "project-agents", "custom", "user-dsh", "user-agents"],
	);
	assert.deepEqual(
		roots.map((root) => root.rank),
		[100, 200, 300, 400, 500],
	);
	assert.equal(roots[0].path, join(home, "repo", ".dsh", "skills"));
	assert.equal(roots[2].path, custom);
	assert.equal(roots[3].skipSystem, true);

	const noCustom = await resolveRoots(resolveManagerConfig({ dshHome: join(home, "dsh"), agentsHome: join(home, "agents") }), join(home, "repo"));
	assert.equal(noCustom.some((root) => root.source === "custom"), false);
});

test("scanAllRoots discovers bundles and flat files, flags invalid entries and shadows", async () => {
	const home = await tempDir();
	const userRoot = join(home, "dsh", "skills");
	const projectRoot = join(home, "repo", ".dsh", "skills");
	await mkdir(join(userRoot, "good-skill"), { recursive: true });
	await writeFile(join(userRoot, "good-skill", "SKILL.md"), "---\nname: good-skill\ndescription: user copy\n---\n\nUser body\n");
	await writeFile(join(userRoot, "flat-skill.md"), "---\nname: flat-skill\ndescription: flat file\n---\n\nFlat body\n");
	await mkdir(join(userRoot, "broken"), { recursive: true });
	await writeFile(join(userRoot, "broken", "SKILL.md"), "---\nname: broken\ndescription: [broken yaml\n---\nbody");
	await mkdir(join(userRoot, "no-skill-md"), { recursive: true });
	await mkdir(join(userRoot, ".system"), { recursive: true });
	await writeFile(join(userRoot, ".system", "sys.md"), "---\nname: sys\ndescription: system\n---\n");
	await mkdir(join(projectRoot, "good-skill"), { recursive: true });
	await writeFile(join(projectRoot, "good-skill", "SKILL.md"), "---\nname: good-skill\ndescription: project copy\n---\n\nProject body\n");

	const config = resolveManagerConfig({ dshHome: join(home, "dsh"), agentsHome: join(home, "agents") });
	const roots = await resolveRoots(config, join(home, "repo"));
	const scan = await scanAllRoots(roots);

	const names = scan.entries.filter((entry) => entry.valid).map((entry) => `${entry.name}@${entry.root.source}`);
	assert.deepEqual(names.sort(), ["flat-skill@user-dsh", "good-skill@project-dsh", "good-skill@user-dsh"]);

	const projectCopy = scan.entries.find((entry) => entry.name === "good-skill" && entry.root.source === "project-dsh");
	const userCopy = scan.entries.find((entry) => entry.name === "good-skill" && entry.root.source === "user-dsh");
	assert.equal(projectCopy.effective, true);
	assert.equal(userCopy.effective, false);

	const broken = scan.entries.find((entry) => entry.path.includes("broken"));
	assert.equal(broken.valid, false);
	assert.equal(broken.problems.length > 0, true);

	assert.equal(scan.entries.some((entry) => entry.name === "sys"), false);
	assert.equal(scan.ignored.some((item) => item.path.endsWith("no-skill-md")), true);
	await rm(home, { recursive: true, force: true });
});

test("createSkill scaffolds a valid bundle the scanner rediscovers", async () => {
	const home = await tempDir();
	const config = resolveManagerConfig({ dshHome: join(home, "dsh"), agentsHome: join(home, "agents") });
	const roots = await resolveRoots(config, join(home, "repo"));
	const entry = await createSkill(roots, { name: "new-skill", description: "Brand new", scope: "user", content: "Hello body" });
	assert.equal(entry.valid, true);
	assert.equal(entry.path, join(home, "dsh", "skills", "new-skill", "SKILL.md"));
	const raw = await readFile(entry.path, "utf8");
	assert.match(raw, /^---\nname: new-skill\ndescription: Brand new\n---\n\nHello body\n$/);

	await assert.rejects(
		createSkill(roots, { name: "new-skill", description: "dup", scope: "user" }),
		/file already exists/,
	);
	await assert.rejects(
		createSkill(roots, { name: "Bad Name", description: "x", scope: "user" }),
		/invalid skill name/,
	);

	const projectEntry = await createSkill(roots, { name: "proj-skill", description: "in repo", scope: "project" });
	assert.equal(projectEntry.root.source, "project-dsh");
	await rm(home, { recursive: true, force: true });
});

test("createSkill writes restrictive invocation keys only when asked", async () => {
	const home = await tempDir();
	const config = resolveManagerConfig({ dshHome: join(home, "dsh"), agentsHome: join(home, "agents") });
	const roots = await resolveRoots(config, join(home, "repo"));
	const entry = await createSkill(roots, {
		name: "hidden-skill",
		description: "not for the model",
		scope: "user",
		modelInvocation: false,
		userInvocation: false,
		whenToUse: "Only for humans",
	});
	const raw = await readFile(entry.path, "utf8");
	assert.match(raw, /whenToUse: Only for humans/);
	assert.match(raw, /disable-model-invocation: true/);
	assert.match(raw, /user-invocable: false/);
	assert.deepEqual(entry.invocation, { modelInvocable: false, userInvocable: false });
	await rm(home, { recursive: true, force: true });
});

test("updateSkillFile merges frontmatter, preserves unknown keys, clears on default", async () => {
	const home = await tempDir();
	const config = resolveManagerConfig({ dshHome: join(home, "dsh"), agentsHome: join(home, "agents") });
	const roots = await resolveRoots(config, join(home, "repo"));
	const entry = await createSkill(roots, {
		name: "updatable",
		description: "before",
		scope: "user",
		content: "old body",
		metadata: { version: 1, keep: true },
	});
	await writeFile(entry.path, "---\nname: updatable\ndescription: before\nmetadata:\n  version: 1\n  keep: true\nlicense: MIT\n---\n\nold body\n");

	const updated = await updateSkillFile(entriesByName((await scanAllRoots(roots)).entries, "updatable")[0], {
		description: "after",
		modelInvocation: false,
		content: "new body",
	});
	assert.equal(updated.description, "after");
	assert.deepEqual(updated.invocation, { modelInvocable: false, userInvocable: true });
	assert.equal(updated.metadata.keep, true);
	assert.equal(updated.metadata.version, 1);
	const raw = await readFile(updated.path, "utf8");
	assert.match(raw, /license: MIT/);
	assert.equal(updated.body.includes("new body"), true);

	const reenabled = await updateSkillFile(updated, { modelInvocation: true });
	assert.equal(reenabled.invocation.modelInvocable, true);
	const raw2 = await readFile(reenabled.path, "utf8");
	assert.doesNotMatch(raw2, /disable-model-invocation/);
	await rm(home, { recursive: true, force: true });
});

test("deleteSkillEntry removes bundles and flat files and refuses stale names", async () => {
	const home = await tempDir();
	const config = resolveManagerConfig({ dshHome: join(home, "dsh"), agentsHome: join(home, "agents") });
	const roots = await resolveRoots(config, join(home, "repo"));
	const bundle = await createSkill(roots, { name: "gone-soon", description: "x", scope: "user", content: "b" });
	const flat = await createSkill(roots, { name: "flat-gone", description: "x", scope: "user", format: "flat", content: "f" });

	const removal = await deleteSkillEntry(bundle);
	assert.deepEqual(removal.removed, [join(home, "dsh", "skills", "gone-soon")]);
	await deleteSkillEntry(flat);

	const scan = await scanAllRoots(roots);
	assert.equal(entriesByName(scan.entries, "gone-soon").length, 0);
	assert.equal(entriesByName(scan.entries, "flat-gone").length, 0);

	const recreated = await createSkill(roots, { name: "stale", description: "x", scope: "user" });
	await writeFile(recreated.path, "---\nname: renamed\ndescription: x\n---\nbody");
	await assert.rejects(deleteSkillEntry(recreated), /now declares skill "renamed"/);
	await rm(home, { recursive: true, force: true });
});
