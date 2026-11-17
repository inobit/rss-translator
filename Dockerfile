# instabox box 镜像
# 运行 CF Worker 的解析/翻译执行者（Hono HTTP 服务），纯 KV 读写。
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate \
    && pnpm install --frozen-lockfile

COPY tsconfig.json vite.config.box.ts ./
COPY src ./src
COPY box-server.ts ./
RUN pnpm run build:box

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
# 仅复制产物（含全部依赖与源码，vite 已打包无外部依赖）
COPY --from=build /app/dist-box /app/dist-box
COPY --from=build /app/node_modules /app/node_modules

EXPOSE 8788
ENV INSTABOX_PORT=8788
CMD ["node", "/app/dist-box/box-server.js"]