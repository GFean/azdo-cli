import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  outDir: "dist",
  banner: {
    js: "#!/usr/bin/env node",
  },
});
