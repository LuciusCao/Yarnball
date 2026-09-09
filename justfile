# 毛线团 Yarnball —— 常用命令封装（底层仍是 pnpm；数据库为内嵌 SQLite，无 Docker 依赖）
# 用法：just --list 查看全部命令

set shell := ["bash", "-cu"]

# 默认：列出所有命令
default:
    @just --list

# 启动全部：server(:18788) + web(:15173)，后台运行，日志在 .logs/
# （SQLite 内嵌于 server 进程，无需先起数据库；首次运行请先 just migrate）
up:
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

# 停止 server + web
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

# 查看服务状态（pid / 端口 / DB 文件）
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
    dbpath="${DATABASE_URL:-$HOME/.yarnball/yarnball.db}"
    if [ -f "$dbpath" ]; then
      echo "db: $dbpath ($(du -h "$dbpath" | cut -f1))"
    else
      echo "db: $dbpath 不存在（先跑 just migrate）"
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

# （已废弃）数据库已内嵌为 SQLite 文件，无需启动/停止；此命令仅为兼容保留
db-up:
    @echo "db-up 已废弃：SQLite 内嵌于 server 进程，无需起库。初始化请用 just migrate"

# （已废弃）同 db-up
db-down:
    @echo "db-down 已废弃：SQLite 无独立进程，just down 即停全部"

# 执行数据库迁移（SQLite，首次运行会创建 DB 文件）
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

# Tauri 桌面壳 dev（前置：just up 已跑起 vite + server）
tauri-dev:
    pnpm tauri:dev

# Tauri 打 dmg（sidecar + web 产物），产物在 apps/tauri/src-tauri/target/release/bundle/dmg/
package:
    pnpm tauri:package
    @echo "dmg 产物：apps/tauri/src-tauri/target/release/bundle/dmg/"

# （之后还需 pnpm -C apps/tauri exec tauri icon icons/app-icon.png -o src-tauri/icons 产出全尺寸图标）
# 从 apps/web/public/icon-1024.png 重生成图标种子 icons/app-icon.png
icon:
    pnpm -C apps/tauri gen:icon

# 首次初始化：装依赖 + 准备 .env + 迁移（SQLite，无需 Docker）
setup:
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
