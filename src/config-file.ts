import fs from "node:fs";
import path from "node:path";

export const CONFIG_FILENAME = "azdo.config.json";

export type PipelineEntry = {
  id: number;
  name?: string;
  branch?: string;
  path?: string;
};

export type AzdoConfig = {
  orgUrl: string;
  project: string;
  auth?: { patEnv?: string };
  defaults?: { branch?: string; pollMs?: number };
  pipelines?: Record<string, PipelineEntry>;
};

export function getConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, CONFIG_FILENAME);
}

export function loadConfig(cwd = process.cwd()): AzdoConfig | null {
  const configPath = getConfigPath(cwd);
  if (!fs.existsSync(configPath)) return null;
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw) as AzdoConfig;
}

export function saveConfig(config: AzdoConfig, cwd = process.cwd()): void {
  const configPath = getConfigPath(cwd);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}
