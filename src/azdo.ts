import type { AzdoConfig } from "./config";

export type TriggerRunInput = {
  pipelineId: number;
  branch: string;
  parameters: Record<string, unknown>;
};

export type RunInfo = {
  id: number;
  state?: string;
  result?: string;
  url?: string;
};

export type PipelineInfo = {
  id: number;
  name: string;
  folder?: string;
};

export type PipelineDefinition = {
  id: number;
  name: string;
  folder?: string;
  configuration?: {
    type?: string;
    path?: string;
    repository?: {
      id?: string;
      name?: string;
      type?: string;
      defaultBranch?: string;
    };
  };
};

function getAuthHeader(pat: string): string {
  const token = Buffer.from(`:${pat}`).toString("base64");
  return `Basic ${token}`;
}

function normalizeOrgUrl(orgUrl: string): string {
  return orgUrl.replace(/\/$/, "");
}

function getRunUrl(run: any): string | undefined {
  return run?._links?.web?.href ?? run?.url;
}

async function azdoRequest<T>(
  config: AzdoConfig,
  path: string,
  options: RequestInit
): Promise<T> {
  const project = encodeURIComponent(config.project);
  const url = `${normalizeOrgUrl(config.orgUrl)}/${project}/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: getAuthHeader(config.pat),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AzDO API error ${res.status}: ${body}`);
  }

  return (await res.json()) as T;
}

export async function triggerPipelineRun(
  config: AzdoConfig,
  input: TriggerRunInput
): Promise<RunInfo> {
  const refName = input.branch.startsWith("refs/")
    ? input.branch
    : `refs/heads/${input.branch}`;
  const body = {
    resources: {
      repositories: {
        self: {
          refName,
        },
      },
    },
    templateParameters: input.parameters,
  };

  const run = await azdoRequest<any>(
    config,
    `_apis/pipelines/${input.pipelineId}/runs?api-version=7.1-preview.1`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );

  return {
    id: run.id,
    state: run.state,
    result: run.result,
    url: getRunUrl(run),
  };
}

export async function getRun(
  config: AzdoConfig,
  pipelineId: number,
  runId: number
): Promise<RunInfo> {
  const run = await azdoRequest<any>(
    config,
    `_apis/pipelines/${pipelineId}/runs/${runId}?api-version=7.1-preview.1`,
    { method: "GET" }
  );

  return {
    id: run.id,
    state: run.state,
    result: run.result,
    url: getRunUrl(run),
  };
}

export async function listPipelines(config: AzdoConfig): Promise<PipelineInfo[]> {
  const res = await azdoRequest<{ value?: Array<{ id: number; name: string; folder?: string }> }>(
    config,
    "_apis/pipelines?api-version=7.1-preview.1",
    { method: "GET" }
  );

  return (res.value ?? []).map((p) => ({ id: p.id, name: p.name, folder: p.folder }));
}

export async function getPipelineDefinition(
  config: AzdoConfig,
  pipelineId: number
): Promise<PipelineDefinition> {
  return azdoRequest<PipelineDefinition>(
    config,
    `_apis/pipelines/${pipelineId}?api-version=7.1-preview.1`,
    { method: "GET" }
  );
}

function normalizeBranch(branch?: string): string | undefined {
  if (!branch) return undefined;
  return branch.replace(/^refs\/heads\//, "");
}

export async function getPipelineYaml(
  config: AzdoConfig,
  pipelineId: number,
  branch?: string
): Promise<{ content?: string; path?: string; repositoryType?: string }> {
  const pipeline = await getPipelineDefinition(config, pipelineId);
  const cfg = pipeline.configuration;
  if (!cfg || cfg.type !== "yaml") {
    return { repositoryType: cfg?.type };
  }
  const repo = cfg.repository;
  if (!repo?.id || repo.type !== "azureReposGit" || !cfg.path) {
    return { path: cfg.path, repositoryType: repo?.type };
  }

  const query = new URLSearchParams({
    path: cfg.path,
    includeContent: "true",
    resolveLfs: "true",
    "api-version": "7.1-preview.1",
  });

  const branchName = normalizeBranch(branch) ?? normalizeBranch(repo.defaultBranch);
  if (branchName) {
    query.set("versionDescriptor.version", branchName);
    query.set("versionDescriptor.versionType", "branch");
  }

  const res = await azdoRequest<{ content?: string }>(
    config,
    `_apis/git/repositories/${repo.id}/items?${query.toString()}`,
    { method: "GET" }
  );

  return { content: res.content, path: cfg.path, repositoryType: repo.type };
}

export type WaitOptions = {
  pollMs: number;
  timeoutMs: number;
  onUpdate?: (run: RunInfo) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCompletion(
  config: AzdoConfig,
  pipelineId: number,
  runId: number,
  options: WaitOptions
): Promise<RunInfo> {
  const started = Date.now();
  while (true) {
    const run = await getRun(config, pipelineId, runId);
    options.onUpdate?.(run);
    if (run.state === "completed") {
      return run;
    }

    if (Date.now() - started > options.timeoutMs) {
      throw new Error("Timed out waiting for pipeline run to complete");
    }

    await sleep(options.pollMs);
  }
}
