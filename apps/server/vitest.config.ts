import { defineConfig } from "vitest/config";

/**
 * vitest 配置（v0.4 协作测试基建）。
 *
 * hookTimeout 放宽到 60s：权限矩阵/同伴入口等套件的 beforeAll 走真实迁移 + 建行程，
 * 城市解析（Nominatim/Photon）是外网调用——上游慢或限流时默认 10s 会把整个套件
 * 卡死在钩子超时（51 个用例全 skip），这是 2026-09-17 并行验证时的实测坑。
 * 测试本身断言不含网络超时预期，放宽钩子预算不影响用例质量。
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
  },
});
