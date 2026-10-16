import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    target: "node20",
    platform: "node",
    clean: true,
    external: [/^node:/],
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    banner: { js: "#!/usr/bin/env node" },
    external: [/^node:/],
  },
]);
