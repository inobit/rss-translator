import { defineConfig } from "vite";
import { builtinModules } from "node:module";

export default defineConfig({
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: true,
    outDir: "dist",
    target: "node22",
    minify: false,
    rollupOptions: {
      input: {
        "cron-vps": "cron-vps.ts",
      },
      external: [
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
      output: {
        entryFileNames: "[name].js",
        codeSplitting: false,
      },
    },
  },
});
