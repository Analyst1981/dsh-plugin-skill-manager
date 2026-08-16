/**
 * Integration test: boot a real cordis context with the actual dsh tools,
 * commands, skills, filesystem-skill-provider, and system-prompt services,
 * then drive the skill_manager tool and the /skills command end to end —
 * including proof that mutations are reflected by the live skill registry
 * (the provider the model's catalog is built from).
 */

import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as filesystemSkill from "@deepseek-ai/dsh-skill-filesystem";
import * as skillManager from "../lib/index.js";

/** Boot the full service stack over a temp home. */
async function bootFixture() {
	const home = await mkdtemp(join(tmpdir(), "dsh-skmgr-it-"));
	const dshHome = join(home, "dsh");
	const agentsHome = join(home, "agents");
	const repo = join(home, "repo");
	await mkdir(join(repo, ".git"), { recursive: true });
	await mkdir(join(dshHome, "skills", "seeded-skill"), { recursive: true });
	await writeFile(join(dshHome, "skills", "seeded-skill", "SKILL.md"), "---\nname: seeded-skill\ndescription: seeded for tests\n---\n\nSeeded body\n");

	const ctx = new Context();
	await ctx.plugin(SystemPrompt);
	await ctx.plugin(ToolRuntime);
	await ctx.plugin(CommandRuntime);
	await ctx.plugin(SkillRegistry);
	await ctx.plugin(filesystemSkill, { dshHome, agentsHome, watch: true });

	const tools = [];
	const commands = [];
	const originalToolRegister = ctx.tools.register.bind(ctx.tools);
	const originalCommandRegister = ctx.commands.register.bind(ctx.commands);
	ctx.tools.register = (tool) => {
		tools.push(tool);
		return originalToolRegister(tool);
	};
	ctx.commands.register = (definition) => {
		commands.push(definition);
		return originalCommandRegister(definition);
	};
	await ctx.plugin(skillManager, { dshHome, agentsHome, defaultScope: "user", bodyPreviewChars: 200 });

	const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: repo } } } };
	const commandInvocation = (rawInput) => ({
		commandId: "test",
		agent: exec.agent,
		rawInput,
		signal: exec.signal,
	});
	return {
		ctx,
		home,
		repo,
		dshHome,
		tool: () => tools.find((candidate) => candidate.name === "skill_manager"),
		command: () => commands.find((candidate) => candidate.name === "skills"),
		exec,
		commandInvocation,
	};
}

test("integration: plugin registers the skill_manager tool and /skills command", async () => {
	const fixture = await bootFixture();
	assert.ok(fixture.tool(), "skill_manager tool registered");
	assert.ok(fixture.command(), "skills command registered");
	assert.match(fixture.command().description, /skill library/i);
	await cleanup(fixture);
});

test("integration: list shows seeded skill as registered in the live registry", async () => {
	const fixture = await bootFixture();
	const result = await fixture.tool().execute({ action: "list" }, fixture.exec);
	assert.equal(result.ok, true);
	const seeded = result.skills.find((skill) => skill.name === "seeded-skill");
	assert.ok(seeded, "seeded skill listed");
	assert.equal(seeded.registered, true);
	assert.equal(seeded.effective, true);
	assert.equal(seeded.valid, true);
	assert.equal(seeded.source, "user-dsh");
	await cleanup(fixture);
});

/**
 * Await the watcher-driven registry invalidation after a mutation: the
 * filesystem provider republishes its catalog asynchronously (Chokidar
 * stability window), so poll the live registry until the expectation holds.
 * @param {Awaited<ReturnType<typeof bootFixture>>} fixture
 * @param {string} name @param {boolean} shouldExist
 */
async function waitForRegistry(fixture, name, shouldExist) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const names = (await fixture.ctx.skills.list({ cwd: fixture.repo })).map((skill) => skill.name);
		if (names.includes(name) === shouldExist) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const names = (await fixture.ctx.skills.list({ cwd: fixture.repo })).map((skill) => skill.name);
	assert.equal(names.includes(name), shouldExist, `registry state for ${name}: ${names.join(", ")}`);
}

test("integration: create/update/delete round-trip through the live skill registry", async () => {
	const fixture = await bootFixture();
	const tool = fixture.tool();

	const created = await tool.execute(
		{ action: "create", name: "round-trip", description: "created by test", content: "Do the thing." },
		fixture.exec,
	);
	assert.equal(created.ok, true);
	assert.equal(created.skills[0].path, join(fixture.dshHome, "skills", "round-trip", "SKILL.md"));
	assert.match(await readFile(created.skills[0].path, "utf8"), /Do the thing\./);

	await waitForRegistry(fixture, "round-trip", true);

	const disabled = await tool.execute(
		{ action: "update", name: "round-trip", model_invocable: false, description: "updated by test" },
		fixture.exec,
	);
	assert.equal(disabled.ok, true);
	assert.deepEqual(disabled.skills[0].invocation, { modelInvocable: false, userInvocable: true });
	assert.match(await readFile(disabled.skills[0].path, "utf8"), /disable-model-invocation: true/);

	const registrySkill = await fixture.ctx.skills.get("round-trip", { cwd: fixture.repo });
	assert.equal(registrySkill.invocation.modelInvocable, false, "registry reflects the disable");

	const updatedBody = await tool.execute(
		{ action: "update", name: "round-trip", content: "Replaced body." },
		fixture.exec,
	);
	assert.match(await readFile(updatedBody.skills[0].path, "utf8"), /Replaced body\./);

	await assert.rejects(
		tool.execute({ action: "delete", name: "round-trip" }, fixture.exec),
		/confirm: true/,
	);
	const deleted = await tool.execute({ action: "delete", name: "round-trip", confirm: true }, fixture.exec);
	assert.equal(deleted.ok, true);
	await waitForRegistry(fixture, "round-trip", false);
	await cleanup(fixture);
});

test("integration: create refuses to clobber an existing skill name", async () => {
	const fixture = await bootFixture();
	await assert.rejects(
		fixture.tool().execute({ action: "create", name: "seeded-skill", description: "dup" }, fixture.exec),
		/already exists/,
	);
	await cleanup(fixture);
});

test("integration: validate reports broken skill files the loader skips", async () => {
	const fixture = await bootFixture();
	const brokenDir = join(fixture.dshHome, "skills", "broken-skill");
	await mkdir(brokenDir, { recursive: true });
	await writeFile(join(brokenDir, "SKILL.md"), "---\nname: broken-skill\ndescription: [bad yaml\n---\nbody");
	const result = await fixture.tool().execute({ action: "validate" }, fixture.exec);
	assert.equal(result.ok, true);
	assert.ok(result.problems.some((problem) => problem.includes("broken-skill")));
	const registryNames = (await fixture.ctx.skills.list({ cwd: fixture.repo })).map((skill) => skill.name);
	assert.equal(registryNames.includes("broken-skill"), false, "provider really skipped it");
	await cleanup(fixture);
});

test("integration: /skills command list/show/create/enable/disable/delete", async () => {
	const fixture = await bootFixture();
	const command = fixture.command();

	const list = await command.handler(fixture.commandInvocation("list"));
	assert.equal(list.kind, "success");
	assert.match(list.text, /seeded-skill/);

	const show = await command.handler(fixture.commandInvocation("show seeded-skill"));
	assert.equal(show.kind, "success");
	assert.match(show.text, /Seeded body/);

	const created = await command.handler(fixture.commandInvocation("create cmd-made skill made from the command"));
	assert.equal(created.kind, "success");
	assert.match(created.text, /Created/);
	assert.ok(await readFile(join(fixture.dshHome, "skills", "cmd-made", "SKILL.md"), "utf8").then((raw) => raw.includes("skill made from the command")));

	const disabled = await command.handler(fixture.commandInvocation("disable cmd-made"));
	assert.equal(disabled.kind, "success");
	assert.match(disabled.text, /Disabled cmd-made/);
	const enabled = await command.handler(fixture.commandInvocation("enable cmd-made"));
	assert.equal(enabled.kind, "success");

	const refused = await command.handler(fixture.commandInvocation("delete cmd-made"));
	assert.equal(refused.kind, "error");
	assert.match(refused.text, /--yes/);
	const deleted = await command.handler(fixture.commandInvocation("delete cmd-made --yes"));
	assert.equal(deleted.kind, "success");
	assert.match(deleted.text, /Removed/);

	const unknown = await command.handler(fixture.commandInvocation("show nope"));
	assert.equal(unknown.kind, "error");
	await cleanup(fixture);
});

/** @param {Awaited<ReturnType<typeof bootFixture>>} fixture */
async function cleanup(fixture) {
	await fixture.ctx.fiber.dispose().catch(() => {});
	await rm(fixture.home, { recursive: true, force: true });
}
