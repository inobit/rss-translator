/**
 * instabox box server 打包配置（可选）
 * 若需把 box-server 编译为单一 JS：`npx vite build --config vite.config.box.ts`
 * 也可不编译，直接用 `node --experimental-strip-types box-server.ts` 运行。
 */
import { defineConfig } from "vite";
import { builtinModules } from "node:module";

export default defineConfig({
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: true,
    outDir: "dist-box",
    target: "node22",
    minify: false,
    rollupOptions: {
      input: {
        "box-server": "box-server.ts",
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