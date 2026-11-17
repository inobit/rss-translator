# RSS Translator — 部署 Makefile
#
# 架构：CF Worker（纯读 + 转发）+ instabox box（解析/翻译执行者，Docker）
#
# 常用：
#   make deploy-box        构建 box 产物 → 推送到 box → 重启容器
#   make push-config       推送 config.yaml 到 Cloudflare KV
#   make deploy            推送配置 + 部署 box
#   make logs              查看 box 容器日志
#   make health            检查 box 健康状态
#
-include .env

# ---- instabox box 配置 ----
BOX       ?= general
BOX_DIR   ?= /data/home/rss-translator
BOX_PORT  ?= 8788
CONTAINER ?= rss-instabox

# box 运行需要的三个文件（dist-box 为构建产物，另两个为仓库内配置）
BOX_FILES = dist-box Dockerfile docker-compose.yml

.PHONY: all build push-config deploy deploy-box deploy-worker restart logs health clean help

all: build

help: ## 显示帮助
	@echo "RSS Translator 部署（CF Worker + instabox box）"
	@echo ""
	@echo "  make build          构建 box 产物 dist-box/box-server.js"
	@echo "  make push-config    推送 config.yaml 到 Cloudflare RSS_CONFIG KV"
	@echo "  make deploy-box     构建 + 推送产物到 instabox box + 重启容器"
	@echo "  make deploy         推送配置 + 部署 box"
	@echo "  make deploy-worker  本地 wrangler deploy（Worker 亦可由 Git 集成自动部署）"
	@echo "  make restart        仅重启 box 容器（不重新构建）"
	@echo "  make logs           查看 box 容器日志"
	@echo "  make health         检查 box 健康状态"
	@echo "  make clean          清理构建产物"
	@echo ""
	@echo "变量（可覆盖）："
	@echo "  BOX=$(BOX)           instabox box 名"
	@echo "  BOX_DIR=$(BOX_DIR)"
	@echo "  BOX_PORT=$(BOX_PORT)"
	@echo ""
	@echo "示例："
	@echo "  make deploy-box BOX=general"
	@echo "  make logs"

build: ## 构建 box 产物（dist-box/box-server.js，自包含）
	pnpm run build:box

push-config: ## 推送 config.yaml 到 RSS_CONFIG KV
	pnpm run push-config

deploy-box: build ## 构建 + 推送 dist-box/Dockerfile/docker-compose.yml 到 box + 重启
	@echo "📦 打包 $(BOX_FILES) → $(BOX):$(BOX_DIR)"
	@tar -czf - $(BOX_FILES) | instabox exec $(BOX) --stdin -- \
		'mkdir -p $(BOX_DIR) && tar -xzf - -C $(BOX_DIR)'
	@echo "🔄 重启容器..."
	@instabox exec $(BOX) -- 'cd $(BOX_DIR) && docker compose up -d --build'
	@echo "✅ box 部署完成"

deploy-worker: ## 本地 wrangler deploy（Git 集成已配置时可跳过）
	pnpm run deploy

deploy: push-config deploy-box ## 推送配置 + 部署 box

restart: ## 仅重启 box 容器
	@instabox exec $(BOX) -- 'cd $(BOX_DIR) && docker compose restart'
	@echo "✅ 容器已重启"

logs: ## 查看 box 容器日志
	@instabox exec $(BOX) -- 'docker logs $(CONTAINER) --tail 50 -f'

health: ## 检查 box 健康状态
	@instabox exec $(BOX) -- 'curl -s http://127.0.0.1:$(BOX_PORT)/health; echo'

clean: ## 清理构建产物
	rm -rf dist-box/
