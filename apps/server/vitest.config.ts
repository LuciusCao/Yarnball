import { defineConfig } from "vitest/config";

/**
 * vitest 配置（v0.4 协作测试基建）。
 *
 * hookTimeout / testTimeout 放宽到 60s：套件的 beforeAll 走真实迁移 + 建行程，
 * 个别用例体内也会建行程（如「建行程即落默认 viewer 链接」），城市解析
 * （Nominatim/Photon）是外网调用——上游慢或限流时默认 10s/5s 会超时
 * （钩子超时 = 整个套件 skip；用例超时 = 偶发单例红）。2026-09-17 实测坑：
 * #21 收尾验证时同一用例 16 连跑第 8 次红（Nominatim ECONNRESET 高峰）。
 * 断言不含网络超时预期，放宽预算不影响用例质量（外网不可达时
 * resolveDestination 静默降级 center=null，用例断言的是鉴权而非地理结果）。
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
