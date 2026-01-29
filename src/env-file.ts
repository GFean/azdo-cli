import fs from "node:fs";
import path from "node:path";

export function upsertEnvVar(cwd: string, key: string, value: string): void {
  const envPath = path.join(cwd, ".env");
  const line = `${key}=${value}`;

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, line + "\n", "utf8");
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);

  let found = false;
  const out = lines.map((l) => {
    if (l.startsWith(`${key}=`)) {
      found = true;
      return line;
    }
    return l;
  });

  if (!found) out.push(line);

  const final =
    out
      .filter((l, i, arr) => !(i === arr.length - 1 && l.trim() === ""))
      .join("\n") + "\n";

  fs.writeFileSync(envPath, final, "utf8");
}
