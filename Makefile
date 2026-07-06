# RSS Translator — 部署 Makefile
-include .env

RSS_VPS ?=
DIR     ?= /opt/rss-translator

.PHONY: all build push-config deploy-cf deploy-vps deploy clean help

help: ## 显示帮助
	@echo "RSS Translator 部署"
	@echo ""
	@echo "  make build             打包 cron 为 dist/cron-vps.js"
	@echo "  make push-config       推送 config.yaml 到 Cloudflare KV"
	@echo "  make deploy-cf         推送配置 + 部署 Worker 到 Cloudflare"
	@echo "  make deploy-vps        构建 + 推送配置 + 复制到 VPS + 安装定时任务"
	@echo "  make deploy            git push + deploy-vps"
	@echo "  make clean             清理构建产物"
	@echo ""
	@echo "必需变量："
	@echo "  RSS_VPS=my-vps  或  RSS_VPS=user@192.168.1.100"
	@echo ""
	@echo "可选变量："
	@echo "  DIR=/opt/rss-translator"
	@echo ""
	@echo "示例："
	@echo "  make deploy RSS_VPS=vps"
	@echo "  make deploy-vps RSS_VPS=admin@10.0.0.1"

all: build

build: ## 打包 cron-vps.ts → dist/cron-vps.js
	pnpm run build:cron

push-config: ## 推送 config.yaml 到 RSS_CONFIG KV
	pnpm run push-config

deploy-cf: push-config ## 推送配置 + 部署 Worker 到 Cloudflare
	pnpm run deploy

deploy-vps: build push-config ## 复制脚本到 VPS + 安装 systemd 定时任务
	@test -n "$(RSS_VPS)" || (echo "❌ 请指定 RSS_VPS: make deploy-vps RSS_VPS=my-vps"; exit 1)
	@echo "📦 创建目录 $(RSS_VPS):$(DIR)..."
	ssh -t $(RSS_VPS) "sudo mkdir -p $(DIR) && sudo chown \$$USER $(DIR)"
	@echo "📦 复制文件..."
	scp dist/cron-vps.js "$(RSS_VPS):$(DIR)/"
	scp systemd/rss-cron-*.service systemd/rss-cron-*.timer "$(RSS_VPS):$(DIR)/"
	@echo "⏱  安装 systemd 定时任务..."
	ssh -t $(RSS_VPS) "sudo bash -c ' \
		ln -sf $(DIR)/rss-cron-articles.service /etc/systemd/system/ && \
		ln -sf $(DIR)/rss-cron-meta.service     /etc/systemd/system/ && \
		ln -sf $(DIR)/rss-cron-articles.timer   /etc/systemd/system/ && \
		ln -sf $(DIR)/rss-cron-meta.timer       /etc/systemd/system/ && \
		systemctl daemon-reload && \
		systemctl enable rss-cron-articles.timer rss-cron-meta.timer && \
		systemctl restart rss-cron-articles.timer rss-cron-meta.timer && \
		echo \"✅ Systemd timers installed and started\"'"
	@echo "✅ 部署完成"

deploy: ## git push + deploy-vps
	git push
	$(MAKE) deploy-vps RSS_VPS=$(RSS_VPS) DIR=$(DIR)

clean: ## 清理构建产物
	rm -rf dist/
