# 毛线团 Yarnball —— 常用命令封装（底层仍是 pnpm / docker compose）
# 用法：just --list 查看全部命令

set shell := ["bash", "-cu"]

# 默认：列出所有命令
default:
    @just --list

# 启动全部：数据库 + server(:18788) + web(:15173)，后台运行，日志在 .logs/
up: db-up
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p .logs
    for svc in server web; do
      pidfile=".logs/$svc.pid"
      if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
        echo "$svc 已在运行 (pid $(cat "$pidfile"))"
      else
        rm -f "$pidfile"
        nohup pnpm "dev:$svc" > ".logs/$svc.log" 2>&1 &
        echo $! > "$pidfile"
        echo "$svc 已启动 (pid $!)，日志 .logs/$svc.log"
      fi
    done
    echo "server → http://localhost:18788 / web → http://localhost:15173"

# 停止 server + web（数据库不动；停库用 just db-down）
down:
    #!/usr/bin/env bash
    set -uo pipefail
    kill_tree() {
      for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
      kill "$1" 2>/dev/null || true
    }
    stopped=0
    for svc in server web; do
      pidfile=".logs/$svc.pid"
      if [ -f "$pidfile" ]; then
        pid="$(cat "$pidfile")"
        if kill -0 "$pid" 2>/dev/null; then
          kill_tree "$pid"
          echo "$svc 已停止 (pid $pid)"
        else
          echo "$svc 进程已不存在"
        fi
        rm -f "$pidfile"
        stopped=1
      fi
    done
    [ "$stopped" = 1 ] || echo "没有正在运行的服务"

# 重启 server + web
restart: down up

# 查看服务状态（pid / 端口）
status:
    #!/usr/bin/env bash
    set -uo pipefail
    for svc in server web; do
      pidfile=".logs/$svc.pid"
      if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
        echo "$svc: 运行中 (pid $(cat "$pidfile"))"
      else
        echo "$svc: 未运行"
      fi
    done
    if docker ps --format '{{"{{"}}.Names}}' 2>/dev/null | grep -q '^yarnball-db$'; then
      echo "db: 运行中 (docker: yarnball-db)"
    else
      echo "db: 未运行"
    fi

# 跟踪日志（just logs 全部，just logs server 只看 server）
logs svc="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{svc}}" ]; then
      tail -f ".logs/{{svc}}.log"
    else
      tail -f .logs/server.log .logs/web.log
    fi

# 启动数据库（Postgres 16 @ localhost:5433）
db-up:
    docker compose up -d db

# 停止数据库（含容器；数据保留在 pgdata volume）
db-down:
    docker compose down

# 执行数据库迁移
migrate:
    pnpm db:migrate

# 改完 schema.ts 后生成迁移 SQL
generate:
    pnpm db:generate

# 全量构建（server: tsc --noEmit；web: tsc -b && vite build）
build:
    pnpm build

# vitest（server）
test:
    pnpm test

# fake-acp-agent 端到端冒烟（前置：just up 已运行、DB 已迁移）
smoke:
    pnpm smoke

# 提交前质量门：build + smoke（前置同 smoke）
verify:
    pnpm verify

# 首次初始化：装依赖 + 准备 .env + 起库 + 迁移
setup: db-up
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm install
    for f in .env apps/server/.env; do
      if [ ! -f "$f" ]; then
        cp .env.example "$f"
        echo "已创建 $f（请按需修改）"
      fi
    done
    pnpm db:migrate
