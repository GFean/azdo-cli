import { loadStoredPat } from "./pat-store";

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

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

function resolvePat(): string {
  const storedPat = loadStoredPat();
  if (storedPat) return storedPat;

  throw new Error("Not authenticated. Run azdo login first.");
}

export function getAzdoEnv(requireOrgProject = true): AzdoEnv {
  const pat = resolvePat();
  const orgUrl = optionalEnv("AZDO_ORG_URL");
  const project = optionalEnv("AZDO_PROJECT");
  const defaultBranch = process.env.AZDO_DEFAULT_BRANCH?.trim() || "develop";

  if (requireOrgProject) {
    if (!orgUrl) {
      throw new Error("Missing env AZDO_ORG_URL");
    }
    if (!project) {
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
