import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { consola } from "consola";
import { confirm, intro, isCancel, outro, password, select, text } from "@clack/prompts";
import { createColors, isColorSupported } from "colorette";
import dotenv from "dotenv";
import { getAzdoConfig, getAzdoEnv } from "./config";
import {
  getPipelineYaml,
  listPipelines,
  triggerPipelineRun,
  waitForCompletion,
  type PipelineInfo,
  type RunInfo,
} from "./azdo";
import {
  CONFIG_FILENAME,
  loadConfig,
  saveConfig,
  type AzdoConfig as AzdoFileConfig,
  type PipelineEntry,
} from "./config-file";
import { upsertEnvVar } from "./env-file";
import YAML from "yaml";

const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };

const program = new Command();

dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });
dotenv.config({ path: resolve(process.cwd(), ".env.internal"), override: true, quiet: true });

const shouldColor = (() => {
  if (process.env.NO_COLOR) return false;
  const force =
    process.env.AZDO_COLOR ??
    process.env.FORCE_COLOR ??
    process.env.CLICOLOR_FORCE ??
    process.env.CLICOLOR;
  if (force !== undefined) {
    const normalized = String(force).toLowerCase();
    if (normalized === "0" || normalized === "false") return false;
    return true;
  }
  return isColorSupported || process.stdout.isTTY;
})();

const execFileAsync = promisify(execFile);

const { cyan, green, red, yellow, magenta, bold, dim } = createColors({
  useColor: shouldColor,
});

const ui = {
  start: (message: string) => consola.start(cyan(`⏳ ${message}`)),
  success: (message: string) => consola.success(green(`✅ ${message}`)),
  info: (message: string) => consola.info(cyan(`ℹ️ ${message}`)),
  warn: (message: string) => consola.warn(yellow(`⚠️ ${message}`)),
  error: (message: string) => consola.error(red(`❌ ${message}`)),
};

program.configureHelp({
  sortSubcommands: true,
  sortOptions: false,
  styleTitle: (str) => bold(cyan(str)),
  styleUsage: (str) => bold(str),
  styleCommandText: (str) => green(str),
  styleSubcommandText: (str) => green(str),
  styleOptionText: (str) => yellow(str),
  styleArgumentText: (str) => magenta(str),
  styleDescriptionText: (str) => dim(str),
});

program
  .name("azdo")
  .description("Azure DevOps CLI helper")
  .version(pkg.version ?? "0.0.0");

program.addHelpText(
  "after",
  [
    "",
    "Examples:",
    "  $ azdo init",
    "  $ azdo build",
    "  $ azdo run --pipeline <pipeline_id> --branch develop",
    "",
    "Environment:",
    "  AZDO_ORG_URL, AZDO_PROJECT, AZDO_PAT",
  ].join("\n")
);

function exitIfCancel<T>(value: T): T {
  if (isCancel(value)) {
    outro("Canceled");
    process.exit(1);
  }
  return value;
}

function slugifyPipelineName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "pipeline";
}

function buildPipelineMap(pipelines: PipelineInfo[]): Record<string, { id: number; name: string }> {
  const map: Record<string, { id: number; name: string }> = {};
  for (const pipeline of pipelines) {
    let key = slugifyPipelineName(pipeline.name);
    if (map[key]) {
      key = `${key}_${pipeline.id}`;
    }
    map[key] = { id: pipeline.id, name: pipeline.name };
  }
  return map;
}

function parsePollMs(value: string | number | undefined): number {
  if (value === undefined || value === null || value === "") return 7000;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isNaN(parsed) || parsed <= 0 ? 7000 : parsed;
}

function collectParams(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseParamValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed !== "") return num;
  return trimmed;
}

function parseParams(paramEntries: string[]): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  for (const entry of paramEntries) {
    const idx = entry.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = entry.slice(0, idx).trim();
    const value = entry.slice(idx + 1);
    if (!key) continue;
    params[key] = parseParamValue(value);
  }
  return params;
}

async function listGitBranches(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--format=%(refname:short)"], {
      cwd,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".idea",
  ".vscode",
  ".cache",
]);

async function findYamlFiles(cwd: string): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [cwd];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === ".yml" || ext === ".yaml") {
          results.push(relative(cwd, fullPath));
        }
      }
    }
  }

  return results;
}

function normalizeForMatch(value: string | undefined): string {
  if (!value) return "";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function scoreYamlCandidate(
  filePath: string,
  pipelineKey?: string,
  pipelineName?: string
): number {
  const base = basename(filePath, extname(filePath)).toLowerCase();
  const baseNorm = normalizeForMatch(base);
  const pathNorm = normalizeForMatch(filePath);
  const keyNorm = normalizeForMatch(pipelineKey);
  const nameNorm = normalizeForMatch(pipelineName);

  let score = 0;
  if (keyNorm && baseNorm.includes(keyNorm)) score += 8;
  if (nameNorm && baseNorm.includes(nameNorm)) score += 6;
  if (keyNorm && pathNorm.includes(keyNorm)) score += 4;
  if (nameNorm && pathNorm.includes(nameNorm)) score += 3;
  if (base.includes("azure-pipelines")) score += 2;
  if (pathNorm.includes("pipeline")) score += 1;
  return score;
}

async function selectLocalYamlFile(
  cwd: string,
  pipelineKey?: string,
  pipelineName?: string,
  interactive = true
): Promise<string | null> {
  const files = await findYamlFiles(cwd);
  if (files.length === 0) return null;

  const scored = files
    .map((file) => ({
      file,
      score: scoreYamlCandidate(file, pipelineKey, pipelineName),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  if (scored.length === 1) return scored[0].file;

  const topScore = scored[0].score;
  const top = scored.filter((item) => item.score === topScore);
  if (top.length === 1) return top[0].file;

  if (!interactive) {
    return top[0].file;
  }

  const selection = String(
    exitIfCancel(
      await select({
        message: "📄 Select pipeline YAML file",
        options: top.map((item) => ({
          value: item.file,
          label: item.file,
        })),
      })
    )
  );
  return selection;
}

async function readLocalYaml(cwd: string, filePath: string): Promise<string | null> {
  const fullPath = resolve(cwd, filePath);
  try {
    const content = await readFile(fullPath, "utf8");
    return content;
  } catch {
    return null;
  }
}

function parseUnknownParamFlags(args: string[]): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--") continue;

    if (arg.startsWith("--no-")) {
      const key = arg.slice(5);
      if (key) params[key] = false;
      continue;
    }

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const value = arg.slice(eq + 1);
        if (key) params[key] = parseParamValue(value);
        continue;
      }

      const key = arg.slice(2);
      const next = args[i + 1];
      if (key) {
        if (next && (!next.startsWith("-") || /^-\d/.test(next))) {
          params[key] = parseParamValue(next);
          i += 1;
        } else {
          params[key] = true;
        }
      }
    }
  }
  return params;
}

function defaultsFromSpecs(specs: PipelineParamSpec[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const spec of specs) {
    if (spec.default !== undefined) {
      params[spec.name] = spec.default;
    }
  }
  return params;
}

type PipelineSelection = {
  key?: string;
  id: number;
  name?: string;
  branch?: string;
  path?: string;
};

type PipelineParamSpec = {
  name: string;
  type: string;
  default?: unknown;
  values?: unknown[];
};

function normalizePipelineEntry(entry: PipelineEntry | undefined): PipelineEntry | null {
  if (!entry) return null;
  const id = Number(entry.id);
  if (Number.isNaN(id)) return null;
  return { id, name: entry.name, branch: entry.branch, path: entry.path };
}

function listConfigPipelines(
  pipelines: Record<string, PipelineEntry> | undefined
): Array<{ key: string; entry: PipelineEntry }> {
  const out: Array<{ key: string; entry: PipelineEntry }> = [];
  if (!pipelines) return out;
  for (const [key, entry] of Object.entries(pipelines)) {
    const normalized = normalizePipelineEntry(entry);
    if (!normalized) continue;
    out.push({ key, entry: normalized });
  }
  return out;
}

async function resolvePipelineSelection(
  config: AzdoFileConfig,
  pipelineArg?: string
): Promise<PipelineSelection> {
  const entries = listConfigPipelines(config.pipelines);
  if (pipelineArg) {
    const asNumber = Number(pipelineArg);
    if (!Number.isNaN(asNumber)) {
      const match = entries.find((e) => e.entry.id === asNumber);
      return {
        id: asNumber,
        name: match?.entry.name ?? match?.key,
        branch: match?.entry.branch,
        path: match?.entry.path,
        key: match?.key,
      };
    }
    const match = entries.find((e) => e.key === pipelineArg);
    if (match) {
      return {
        id: match.entry.id,
        name: match.entry.name ?? match.key,
        branch: match.entry.branch,
        path: match.entry.path,
        key: match.key,
      };
    }
    throw new Error(`Unknown pipeline "${pipelineArg}" in ${CONFIG_FILENAME}`);
  }

  if (entries.length === 0) {
    throw new Error(`No pipelines found in ${CONFIG_FILENAME}`);
  }

  const selection = String(
    exitIfCancel(
      await select({
        message: "🎯 Select a pipeline",
        options: entries.map(({ key, entry }) => ({
          value: key,
          label: `${key} — ${entry.name ?? "pipeline"} (#${entry.id})`,
        })),
      })
    )
  );

  const picked = entries.find((e) => e.key === selection);
  if (!picked) {
    throw new Error("Invalid pipeline selection");
  }
  return {
    id: picked.entry.id,
    name: picked.entry.name ?? picked.key,
    branch: picked.entry.branch,
    path: picked.entry.path,
    key: picked.key,
  };
}

function inferParamType(value: unknown): string {
  if (value === null || value === undefined) return "string";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function normalizeParamSpec(param: unknown): PipelineParamSpec | null {
  if (typeof param === "string") {
    return { name: param, type: "string" };
  }
  if (param && typeof param === "object") {
    const obj = param as Record<string, unknown>;
    if (typeof obj.name === "string") {
      const type =
        typeof obj.type === "string" ? obj.type : inferParamType(obj.default);
      const values = Array.isArray(obj.values) ? obj.values : undefined;
      return { name: obj.name, type, default: obj.default, values };
    }
  }
  return null;
}

function extractParamsFromYaml(yamlText: string): PipelineParamSpec[] {
  const doc = YAML.parse(yamlText);
  const params = (doc as Record<string, unknown> | undefined)?.parameters;
  if (!params) return [];
  if (Array.isArray(params)) {
    return params
      .map((p) => normalizeParamSpec(p))
      .filter((p): p is PipelineParamSpec => Boolean(p));
  }
  if (typeof params === "object") {
    return Object.entries(params as Record<string, unknown>).map(
      ([name, value]) => ({
        name,
        type: inferParamType(value),
        default: value,
      })
    );
  }
  return [];
}

function stringifyDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function promptForParameters(
  params: PipelineParamSpec[]
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const param of params) {
    const label = `🧩 Parameter: ${param.name} (press Enter for default)`;
    const type = param.type?.toLowerCase() ?? "string";
    if (Array.isArray(param.values) && param.values.length > 0) {
      const defaultValue =
        param.default !== undefined &&
        param.values.some((v) => v === param.default)
          ? param.default
          : param.values[0];
      const picked = exitIfCancel(
        await select({
          message: label,
          options: param.values.map((value) => ({
            value,
            label: String(value),
          })),
          initialValue: defaultValue,
        })
      );
      result[param.name] = picked;
      continue;
    }

    if (type === "boolean") {
      const initialValue =
        typeof param.default === "boolean" ? param.default : false;
      const picked = exitIfCancel(
        await confirm({
          message: label,
          initialValue,
        })
      );
      result[param.name] = Boolean(picked);
      continue;
    }

    const initialValue = stringifyDefault(param.default);
    const input = String(
      exitIfCancel(
        await text({
          message: label,
          initialValue,
        })
      )
    );

    if (input.trim() === "") {
      if (param.default !== undefined) {
        result[param.name] = param.default;
      }
      continue;
    }

    if (type === "number") {
      const num = Number(input);
      result[param.name] = Number.isNaN(num) ? input : num;
      continue;
    }

    if (type === "object" || type === "array") {
      try {
        result[param.name] = JSON.parse(input);
      } catch {
        result[param.name] = input;
      }
      continue;
    }

    result[param.name] = input;
  }
  return result;
}

function printRun(run: RunInfo): void {
  ui.success(`Run #${run.id}`);
  if (run.url) {
    ui.info(`Open: ${run.url}`);
  }
}

const initCommand = program
  .command("init")
  .description(`Create ${CONFIG_FILENAME} (and optionally .env) in the current directory`)
  .option("--no-write-env", "Do not write AZDO_PAT into .env")
  .option("--interactive", "Prompt with defaults from env")
  .action(async (options: { writeEnv: boolean; interactive: boolean }) => {
    try {
      const envConfig = getAzdoConfig();
      let orgUrl = envConfig.orgUrl;
      let project = envConfig.project;
      let pat = envConfig.pat;

      if (options.interactive) {
        intro("🚀 azdo init");
        orgUrl = String(
          exitIfCancel(
            await text({
              message: "Azure DevOps org URL",
              placeholder: "https://dev.azure.com/your-org",
              initialValue: envConfig.orgUrl,
              validate: (v) => {
                if (!v || v.trim().length === 0) return "Org URL is required";
                if (!v.startsWith("https://")) return "Org URL must start with https://";
                return undefined;
              },
            })
          )
        ).trim();

        project = String(
          exitIfCancel(
            await text({
              message: "Project name",
              placeholder: "Mobile Banking Application",
              initialValue: envConfig.project,
              validate: (v) => (!v || v.trim().length === 0 ? "Project is required" : undefined),
            })
          )
        ).trim();

        const useEnvPat = Boolean(
          exitIfCancel(
            await confirm({
              message: "Use AZDO_PAT from env?",
              initialValue: true,
            })
          )
        );

        if (!useEnvPat) {
          pat = String(
            exitIfCancel(
              await password({
                message: "Personal Access Token (PAT)",
                validate: (v) => (!v || v.trim().length === 0 ? "PAT is required" : undefined),
              })
            )
          ).trim();
        }
      } else {
        ui.start("Generating azdo.config.json from env + Azure DevOps...");
      }

      const pollMs = parsePollMs(process.env.AZDO_POLL_MS);
      const pipelineList = await listPipelines({
        orgUrl,
        project,
        pat,
        defaultBranch: envConfig.defaultBranch,
      });

      const config: AzdoFileConfig = {
        orgUrl,
        project,
        auth: { patEnv: "AZDO_PAT" },
        defaults: { branch: envConfig.defaultBranch, pollMs },
        pipelines: buildPipelineMap(pipelineList),
      };

      saveConfig(config, process.cwd());
      ui.success(
        `Wrote ${CONFIG_FILENAME} (${pipelineList.length} pipelines)`
      );

      if (options.writeEnv) {
        upsertEnvVar(process.cwd(), "AZDO_PAT", pat);
        ui.success("Updated .env (AZDO_PAT)");
      } else {
        ui.info("Skipped writing .env");
      }

      if (options.interactive) {
        outro("✅ Done");
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("Missing env "))) {
        ui.error(err instanceof Error ? err.message : String(err));
      }
      process.exitCode = 1;
    }
  });

initCommand.addHelpText(
  "after",
  [
    "",
    "Examples:",
    "  $ azdo init",
    "  $ azdo init --interactive",
    "",
    "Notes:",
    "  Reads AZDO_ORG_URL/AZDO_PROJECT/AZDO_PAT from .env or shell.",
    "  Uses Azure DevOps API to prefill pipeline IDs in the config.",
  ].join("\n")
);

const buildCommand = program
  .command("build")
  .description("Select a pipeline and run it (prompts for parameters by default)")
  .option("-p, --pipeline <pipeline_id|key>", "Pipeline id or key from azdo.config.json")
  .option("-b, --branch <name>", "Override branch name")
  .option("--param <k=v>", "Template parameter override (repeatable)", collectParams, [])
  .option("--poll <ms>", "Polling interval in ms")
  .option("--no-prompt", "Skip parameter prompts (use defaults + flags)")
  .option("--no-wait", "Do not wait for completion")
  .action(async (options: {
    pipeline?: string;
    branch?: string;
    param: string[];
    poll?: string;
    prompt: boolean;
    wait: boolean;
  }, command: Command) => {
    try {
      const fileConfig = loadConfig(process.cwd());
      if (!fileConfig) {
        throw new Error(`Missing ${CONFIG_FILENAME}. Run azdo init first.`);
      }

      const env = getAzdoEnv(false);
      const orgUrl = fileConfig.orgUrl ?? env.orgUrl;
      const project = fileConfig.project ?? env.project;
      if (!orgUrl || !project) {
        throw new Error("Missing AZDO_ORG_URL/AZDO_PROJECT or orgUrl/project in config");
      }

      const apiConfig = {
        orgUrl,
        project,
        pat: env.pat,
        defaultBranch: env.defaultBranch,
      };

      const selection = await resolvePipelineSelection(fileConfig, options.pipeline);
      const defaultBranch = fileConfig.defaults?.branch ?? env.defaultBranch;
      let branch = options.branch ?? selection.branch ?? defaultBranch;
      if (!options.branch && options.prompt) {
        const method = String(
          exitIfCancel(
            await select({
              message: "🌿 Choose branch input",
              options: [
                { value: "enter", label: "Enter branch name" },
                { value: "select", label: "Select from git branches" },
              ],
            })
          )
        );

        if (method === "enter") {
          const input = String(
            exitIfCancel(
              await text({
                message: "🌿 Branch name",
                initialValue: branch,
              })
            )
          ).trim();
          if (input) branch = input;
        } else {
          const branches = await listGitBranches(process.cwd());
          if (branches.length === 0) {
            ui.warn("No git branches found. Enter a branch name.");
            const input = String(
              exitIfCancel(
                await text({
                  message: "🌿 Branch name",
                  initialValue: branch,
                })
              )
            ).trim();
            if (input) branch = input;
          } else {
            const initial =
              branch && branches.includes(branch) ? branch : branches[0];
            const selected = String(
              exitIfCancel(
                await select({
                  message: "🌿 Select a git branch",
                  options: branches.map((b) => ({ value: b, label: b })),
                  initialValue: initial,
                })
              )
            );
            if (selected) branch = selected;
          }
        }
      }
      const pollMs = parsePollMs(
        options.poll ?? fileConfig.defaults?.pollMs ?? process.env.AZDO_POLL_MS
      );

      let parameters: Record<string, unknown> = {};
      let yamlContent: string | null = null;
      let yamlLabel: string | undefined;
      let repoType: string | undefined;
      let yamlError: string | undefined;

      if (selection.path) {
        const local = await readLocalYaml(process.cwd(), selection.path);
        if (local) {
          yamlContent = local;
          yamlLabel = selection.path;
        }
      }

      if (!yamlContent) {
        try {
          const yamlInfo = await getPipelineYaml(apiConfig, selection.id, branch);
          repoType = yamlInfo.repositoryType;
          if (yamlInfo.content) {
            yamlContent = yamlInfo.content;
            yamlLabel = yamlInfo.path ?? "pipeline YAML";
          }
        } catch (err) {
          yamlError = err instanceof Error ? err.message : String(err);
        }
      }

      if (!yamlContent) {
        const localPick = await selectLocalYamlFile(
          process.cwd(),
          selection.key ?? undefined,
          selection.name ?? undefined,
          options.prompt
        );
        if (localPick) {
          const local = await readLocalYaml(process.cwd(), localPick);
          if (local) {
            yamlContent = local;
            yamlLabel = localPick;
          }
        }
      }

      if (yamlContent) {
        const specs = extractParamsFromYaml(yamlContent);
        if (specs.length > 0) {
          ui.info(`Found ${specs.length} parameters in ${yamlLabel ?? "pipeline YAML"}`);
          if (options.prompt) {
            parameters = await promptForParameters(specs);
          } else {
            parameters = defaultsFromSpecs(specs);
          }
        }
      } else if (repoType && repoType !== "azureReposGit") {
        ui.info(`Skipping parameter prompts (repo type: ${repoType})`);
      } else if (yamlError) {
        ui.warn(`Could not read pipeline YAML parameters: ${yamlError}`);
      } else {
        ui.info("No pipeline YAML found for parameter prompts.");
      }

      const overrideParams = parseParams(options.param ?? []);
      const flagParams = parseUnknownParamFlags(command.args ?? []);
      const mergedParams = {
        ...parameters,
        ...overrideParams,
        ...flagParams,
      } as Record<string, unknown>;

      ui.start("Triggering pipeline...");
      const run = await triggerPipelineRun(apiConfig, {
        pipelineId: selection.id,
        branch,
        parameters: mergedParams,
      });
      ui.success("Build started");
      printRun(run);
      ui.info("You can quit now; the build will continue in Azure DevOps.");

      if (options.wait) {
        ui.start("Waiting for completion...");
        let lastState: string | undefined;
        const completed = await waitForCompletion(apiConfig, selection.id, run.id, {
          pollMs,
          timeoutMs: 60 * 60 * 1000,
          onUpdate: (latest) => {
            if (latest.state !== lastState) {
              lastState = latest.state;
              if (lastState) {
                ui.info(`State: ${lastState}`);
              }
            }
          },
        });
        ui.success("Build completed");
        printRun(completed);
        if (completed.result !== "succeeded") {
          ui.error(`Result: ${completed.result ?? "unknown"}`);
          process.exitCode = 1;
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("Missing env "))) {
        ui.error(err instanceof Error ? err.message : String(err));
      }
      process.exitCode = 1;
    }
  });

buildCommand.addHelpText(
  "after",
  [
    "",
    "Examples:",
    "  $ azdo build",
    "  $ azdo build --pipeline android_staging",
    "  $ azdo build --no-prompt --versionCode 123 --cleanGradleProject true",
    "",
    "Parameter flags:",
    "  Unknown --flags are passed as pipeline parameters.",
    "  Use --param key=value to set or override explicitly.",
    "",
    "Branch selection:",
    "  When prompting, you can type a branch or select from local git branches.",
  ].join("\n")
);

buildCommand.allowUnknownOption();
buildCommand.allowExcessArguments();

const runCommand = program
  .command("run")
  .description("Trigger a pipeline run by id")
  .requiredOption("-p, --pipeline <pipeline_id>", "Pipeline id")
  .option("-b, --branch <name>", "Git branch name")
  .option("--param <k=v>", "Template parameter (repeatable)", collectParams, [])
  .option("--no-wait", "Do not wait for completion")
  .option("--poll <ms>", "Polling interval in ms", "7000")
  .action(async (options: {
    pipeline: string;
    branch?: string;
    param: string[];
    wait: boolean;
    poll: string;
  }, command: Command) => {
    try {
      const config = getAzdoConfig();
      const pipelineId = Number(options.pipeline);
      if (Number.isNaN(pipelineId)) {
        throw new Error("--pipeline must be a number");
      }
      const branch = options.branch ?? config.defaultBranch;
      const parameters = parseParams(options.param ?? []);
      const flagParams = parseUnknownParamFlags(command.args ?? []);
      const mergedParams = {
        ...parameters,
        ...flagParams,
      };

      ui.start("Triggering pipeline...");
      const run = await triggerPipelineRun(config, {
        pipelineId,
        branch,
        parameters: mergedParams,
      });
      ui.success("Pipeline triggered");
      printRun(run);

      if (options.wait) {
        const pollMs = Number(options.poll);
        if (Number.isNaN(pollMs) || pollMs <= 0) {
          throw new Error("--poll must be a positive number");
        }
        ui.start("Waiting for completion...");
        let lastState: string | undefined;
        const completed = await waitForCompletion(config, pipelineId, run.id, {
          pollMs,
          timeoutMs: 60 * 60 * 1000,
          onUpdate: (latest) => {
            if (latest.state !== lastState) {
              lastState = latest.state;
              if (lastState) {
                ui.info(`State: ${lastState}`);
              }
            }
          },
        });
        ui.success("Run completed");
        printRun(completed);
        if (completed.result !== "succeeded") {
          ui.error(`Result: ${completed.result ?? "unknown"}`);
          process.exitCode = 1;
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("Missing env "))) {
        ui.error(err instanceof Error ? err.message : String(err));
      }
      process.exitCode = 1;
    }
  });

runCommand.addHelpText(
  "after",
  [
    "",
    "Examples:",
    "  $ azdo run --pipeline <pipeline_id> --branch develop",
    "  $ azdo run --pipeline <pipeline_id> --poll 10000 --versionCode 123",
    "  $ azdo run --pipeline <pipeline_id> --no-wait --versionCode 123",
    "",
    "Parameter flags:",
    "  Unknown --flags are passed as pipeline parameters.",
    "  Use --param key=value to set or override explicitly.",
  ].join("\n")
);

runCommand.allowUnknownOption();
runCommand.allowExcessArguments();

program.parseAsync(process.argv).catch((err) => {
  ui.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
