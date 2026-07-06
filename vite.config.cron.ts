import { defineConfig } from "vite";
import { builtinModules } from "node:module";

export default defineConfig({
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: "cron-vps.ts",
    outDir: "dist",
    target: "node22",
    minify: false,
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
      output: {
        entryFileNames: "cron-vps.js",
      },
    },
  },
});
