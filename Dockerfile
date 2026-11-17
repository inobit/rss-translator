# instabox box 镜像
# 运行 CF Worker 的解析/翻译执行者（Hono HTTP 服务），纯 KV 读写。
# dist-box/ 由渲染镜像之外的构建产出（`pnpm run build:box`），镜像内不执行构建。
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
# 复制预构建的自包含产物（vite SSR 已打包全部 npm 依赖，仅外置 node 内置模块）
COPY dist-box ./dist-box

EXPOSE 8788
ENV INSTABOX_PORT=8788
CMD ["node", "/app/dist-box/box-server.js"]