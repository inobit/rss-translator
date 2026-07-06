/**
 * Cloudflare KV REST API 适配器
 * 在 VPS 等非 Worker 环境中模拟 KVNamespace 接口，
 * 使现有 cron 逻辑无需修改即可复用。
 *
 * 依赖变量：
 *   CF_ACCOUNT_ID       — Cloudflare 账户 ID
 *   CF_KV_API_TOKEN     — API Token（需 Workers KV Storage 编辑权限）
 *   CF_KV_CONFIG_ID     — RSS_CONFIG namespace ID
 *   CF_KV_CACHE_ID      — RSS_CACHE namespace ID
 */

/// <reference types="@cloudflare/workers-types" />

import type { WorkerEnv } from "../types";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";

/** KV REST API 实现，满足 KVNamespace 的 get/put/delete 接口 */
class RestKVNamespace {
  private baseUrl: string;
  private apiToken: string;

  constructor(accountId: string, namespaceId: string, apiToken: string) {
    this.baseUrl = `${API_BASE}/${accountId}/storage/kv/namespaces/${namespaceId}`;
    this.apiToken = apiToken;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
    };
  }

  async get(key: string): Promise<string | null> {
    const url = `${this.baseUrl}/values/${encodeURIComponent(key)}`;
    const resp = await fetch(url, { headers: this.authHeaders() });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      console.error(`KV GET failed: ${resp.status} ${await resp.text()}`);
      return null;
    }
    return resp.text();
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    let url = `${this.baseUrl}/values/${encodeURIComponent(key)}`;
    if (options?.expirationTtl) {
      url += `?expiration_ttl=${options.expirationTtl}`;
    }
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/octet-stream",
      },
      body: value,
    });
    if (!resp.ok) {
      console.error(
        `KV PUT failed: ${resp.status} ${await resp.text()}`,
      );
    }
  }

  async delete(key: string): Promise<void> {
    const url = `${this.baseUrl}/values/${encodeURIComponent(key)}`;
    const resp = await fetch(url, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!resp.ok && resp.status !== 404) {
      console.error(
        `KV DELETE failed: ${resp.status} ${await resp.text()}`,
      );
    }
  }
}

/** 从环境变量构建 VPS 用 WorkerEnv */
export function createVpsEnv(): WorkerEnv {
  const accountId = requireEnv("CF_ACCOUNT_ID");
  const apiToken = requireEnv("CF_KV_API_TOKEN");
  const configNsId = requireEnv("CF_KV_CONFIG_ID");
  const cacheNsId = requireEnv("CF_KV_CACHE_ID");

  // 将 process.env 中的 KEY=VALUE 映射到 env 对象，
  // 使 resolveProvider 中 env[secretName] 能命中
  const envFromProcess: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) envFromProcess[k] = v;
  }

  return {
    RSS_CONFIG: new RestKVNamespace(
      accountId,
      configNsId,
      apiToken,
    ) as unknown as KVNamespace,
    RSS_CACHE: new RestKVNamespace(
      accountId,
      cacheNsId,
      apiToken,
    ) as unknown as KVNamespace,
    ACCESS_TOKEN: process.env.ACCESS_TOKEN ?? "",
    ...envFromProcess,
  } as unknown as WorkerEnv;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

export { RestKVNamespace };
