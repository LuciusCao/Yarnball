import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get serverPort() {
    return Number(process.env.SERVER_PORT ?? 8787);
  },
  /** agent 子进程访问 MCP 端点的基址。agent 与服务端同机，默认 loopback。 */
  get serverBaseUrl() {
    return process.env.SERVER_BASE_URL ?? `http://127.0.0.1:${this.serverPort}`;
  },
  get webOrigin() {
    return process.env.WEB_ORIGIN ?? "http://localhost:5173";
  },
  get amapServerKey() {
    return process.env.AMAP_SERVER_KEY ?? "";
  },
  get amapJsKey() {
    return process.env.AMAP_JS_KEY ?? "";
  },
  get amapJsSecret() {
    return process.env.AMAP_JS_SECRET ?? "";
  },
  get amapConfigured() {
    return this.amapServerKey !== "" && this.amapJsKey !== "";
  },
};
