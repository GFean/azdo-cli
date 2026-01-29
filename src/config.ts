import { consola } from "consola";

export type AzdoConfig = {
  orgUrl: string;
  project: string;
  pat: string;
  defaultBranch: string;
};

export type AzdoEnv = {
  orgUrl?: string;
  project?: string;
  pat: string;
  defaultBranch: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    consola.error(`Missing required env: ${name}`);
    consola.info("Create a .env file with required variables:");
    consola.info("  AZDO_ORG_URL=https://dev.azure.com/your-org");
    consola.info("  AZDO_PROJECT=Your Project");
    consola.info("  AZDO_PAT=xxxxxxxxxxxxxxxx");
    throw new Error(`Missing env ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export function getAzdoEnv(requireOrgProject = true): AzdoEnv {
  const pat = requireEnv("AZDO_PAT");
  const orgUrl = optionalEnv("AZDO_ORG_URL");
  const project = optionalEnv("AZDO_PROJECT");
  const defaultBranch = process.env.AZDO_DEFAULT_BRANCH?.trim() || "develop";

  if (requireOrgProject) {
    if (!orgUrl) {
      consola.error("Missing required env: AZDO_ORG_URL");
      throw new Error("Missing env AZDO_ORG_URL");
    }
    if (!project) {
      consola.error("Missing required env: AZDO_PROJECT");
      throw new Error("Missing env AZDO_PROJECT");
    }
  }

  return { orgUrl, project, pat, defaultBranch };
}

export function getAzdoConfig(): AzdoConfig {
  const env = getAzdoEnv(true);
  return {
    orgUrl: env.orgUrl as string,
    project: env.project as string,
    pat: env.pat,
    defaultBranch: env.defaultBranch,
  };
}
