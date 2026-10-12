import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Where this build keeps its user-level state.
 *
 * This lives on its own because the config directory name depends on which Pi
 * package is running, and everything that needs a path to user config would
 * otherwise have to import the whole utility module to get one.
 */

const DEFAULT_CONFIG_DIR_NAME = ".pi";
const PI_CODING_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

function validConfigDirName(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function readConfigDirNameFromPackageRoot(packageRoot: string | undefined): string | undefined {
	if (!packageRoot) return undefined;
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")) as {
			name?: unknown;
			piConfig?: { configDir?: unknown };
		};
		if (pkg.name !== PI_CODING_AGENT_PACKAGE_NAME) return undefined;
		return validConfigDirName(pkg.piConfig?.configDir);
	} catch {
		return undefined;
	}
}

function resolveConfigDirNameFromPackageJson(entryPoint = process.argv[1], packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV]): string | undefined {
	const packageRootValue = readConfigDirNameFromPackageRoot(packageRoot);
	if (packageRootValue) return packageRootValue;
	if (!entryPoint) return undefined;
	try {
		let dir = path.dirname(fs.realpathSync(entryPoint));
		while (dir !== path.dirname(dir)) {
			const value = readConfigDirNameFromPackageRoot(dir);
			if (value) return value;
			dir = path.dirname(dir);
		}
	} catch {
		// Package metadata lookup is best-effort; detached runners must not fail here.
	}
	return undefined;
}

export function resolveConfigDirName(codingAgentModule?: unknown, entryPoint?: string, packageRoot?: string): string {
	const moduleValue = codingAgentModule && typeof codingAgentModule === "object"
		? validConfigDirName((codingAgentModule as { CONFIG_DIR_NAME?: unknown }).CONFIG_DIR_NAME)
		: undefined;
	return moduleValue
		?? resolveConfigDirNameFromPackageJson(entryPoint, packageRoot)
		?? DEFAULT_CONFIG_DIR_NAME;
}

let cachedConfigDirName: { entryPoint: string | undefined; packageRoot: string | undefined; value: string } | undefined;

export function getConfigDirName(): string {
	const entryPoint = process.argv[1];
	const packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	if (cachedConfigDirName
		&& cachedConfigDirName.entryPoint === entryPoint
		&& cachedConfigDirName.packageRoot === packageRoot) {
		return cachedConfigDirName.value;
	}
	const value = resolveConfigDirName(undefined, entryPoint, packageRoot);
	cachedConfigDirName = { entryPoint, packageRoot, value };
	return value;
}

export function getProjectConfigDir(projectRoot: string): string {
	return path.join(projectRoot, getConfigDirName());
}

export function getAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
	if (configured === "~") return home;
	if (configured?.startsWith("~/") || configured?.startsWith("~\\")) return path.join(home, configured.slice(2));
	return configured || path.join(home, getConfigDirName(), "agent");
}
