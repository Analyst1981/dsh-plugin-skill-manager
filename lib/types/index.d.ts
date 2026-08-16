/**
 * Type surface for dsh-plugin-skill-manager.
 *
 * @module dsh-plugin-skill-manager
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';

/** Public kebab-case skill-name grammar shared with the dsh skill registry. */
export declare const SKILL_NAME_PATTERN: RegExp;

export declare function isSkillName(name: unknown): boolean;

/** Root precedence ranks mirrored from dsh-skill-filesystem. */
export declare const ROOT_RANKS: Readonly<{
	PROJECT_DSH: 100;
	PROJECT_AGENTS: 200;
	CUSTOM: 300;
	USER_DSH: 400;
	USER_AGENTS: 500;
}>;

export interface ManagerConfig {
	dshHome: string;
	agentsHome: string;
	customSkillDirs: string[];
	defaultScope: 'user' | 'project';
	bodyPreviewChars: number;
}

export declare function resolveManagerConfig(overrides?: Partial<ManagerConfig>): ManagerConfig;

export declare function expandHome(path: string): string;

export declare function findProjectRoot(cwd: string): Promise<string>;

export interface SkillRoot {
	path: string;
	source: 'project-dsh' | 'project-agents' | 'custom' | 'user-dsh' | 'user-agents';
	rank: number;
	scope: 'project' | 'user' | 'custom';
	skipSystem?: boolean;
}

export declare function resolveRoots(config: ManagerConfig, cwd: string | undefined): Promise<SkillRoot[]>;

export declare function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined;

export declare function serializeSkillFile(data: Record<string, unknown>, body: string): string;

export interface SkillEntry {
	name?: string;
	description?: string;
	whenToUse?: string;
	invocation?: { modelInvocable: boolean; userInvocable: boolean };
	metadata?: Record<string, unknown>;
	path: string;
	directory: string;
	format: 'bundle' | 'flat';
	root: SkillRoot;
	problems: string[];
	valid: boolean;
	body: string;
	effective?: boolean;
	registered?: boolean;
}

export interface LibraryScan {
	entries: SkillEntry[];
	ignored: { path: string; reason: string; root: string }[];
	rootErrors: { root: string; error: string }[];
}

export declare function scanRoot(root: SkillRoot): Promise<{ skills: SkillEntry[]; ignored: { path: string; reason: string }[]; rootError?: string }>;

export declare function scanAllRoots(roots: SkillRoot[]): Promise<LibraryScan>;

export declare function defaultSkillBody(name: string, description: string): string;

export interface CreateSkillInput {
	name: string;
	description: string;
	whenToUse?: string;
	metadata?: Record<string, unknown>;
	modelInvocation?: boolean;
	userInvocation?: boolean;
	content?: string;
	scope: 'user' | 'project';
	format?: 'bundle' | 'flat';
}

export declare function createSkill(roots: SkillRoot[], input: CreateSkillInput): Promise<SkillEntry & { created: true }>;

export interface UpdateSkillInput {
	description?: string;
	whenToUse?: string | null;
	metadata?: Record<string, unknown> | null;
	modelInvocation?: boolean;
	userInvocation?: boolean;
	content?: string;
}

export declare function updateSkillFile(entry: SkillEntry, patches: UpdateSkillInput): Promise<SkillEntry>;

export declare function deleteSkillEntry(entry: SkillEntry): Promise<{ removed: string[] }>;

export declare function previewBody(body: string, limit: number): string;

export declare function entriesByName(entries: SkillEntry[], name: string): SkillEntry[];

export declare const name: string;

export declare const inject: string[];

export declare const Config: unknown;

export declare function apply(ctx: Context, config?: Partial<ManagerConfig>): void;

export declare const SKILL_MANAGER_ACTIONS: string[];

declare const entry: { name: string; inject: string[]; Config: unknown; apply: typeof apply };
export default entry;
