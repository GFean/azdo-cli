import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type StoredPat = {
  pat: string;
  updatedAt: string;
};

const STORE_DIR = ".azdo-cli";
const STORE_FILE = "credentials.json";

export function getPatStorePath(): string {
  return path.join(os.homedir(), STORE_DIR, STORE_FILE);
}

export function hasStoredPat(): boolean {
  return Boolean(loadStoredPat());
}

export function loadStoredPat(): string | undefined {
  const storePath = getPatStorePath();
  if (!fs.existsSync(storePath)) return undefined;

  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredPat>;
    const pat = typeof parsed.pat === "string" ? parsed.pat.trim() : "";
    return pat.length > 0 ? pat : undefined;
  } catch {
    return undefined;
  }
}

export function saveStoredPat(pat: string): void {
  const token = pat.trim();
  if (!token) {
    throw new Error("PAT cannot be empty");
  }

  const storePath = getPatStorePath();
  const storeDir = path.dirname(storePath);
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const payload: StoredPat = {
    pat: token,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(storePath, JSON.stringify(payload, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(storePath, 0o600);
}

export function clearStoredPat(): boolean {
  const storePath = getPatStorePath();
  if (!fs.existsSync(storePath)) return false;
  fs.unlinkSync(storePath);
  return true;
}
