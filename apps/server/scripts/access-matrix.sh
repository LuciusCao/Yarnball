#!/usr/bin/env bash
# 权限矩阵 curl 实测脚本（issue #16：多人协作地基）。
#
# 用法：服务端已启动（默认 http://127.0.0.1:18790，可用 YARNBALL_BASE 覆盖）后直接跑：
#   bash apps/server/scripts/access-matrix.sh
# 前置：DB 已迁移（含 0004 trip_access_links）。脚本自建测试行程并在结束时清理。
#
# 覆盖：loopback 无 token 全通 / viewer 读 200 写 403 / editor 写 200 /
#       跨行程 403 / owner-only 403 / 非行程级 403 / 吊销后 401 / 无效 token 401 /
#       owner token 全通 / SSE ?token= / 老 share 链接脱敏结构。
# 注意：本机 curl 来源即 loopback。「带 token 一律按 token 身份处理」的规则让 guest
# 路径可以在本机自测（loopback + Bearer viewer = viewer）；远程匿名场景由 vitest 的
# remote env 模拟覆盖（src/routes/api.access.test.ts），本脚本只做真实 HTTP 冒烟。

set -euo pipefail

BASE="${YARNBALL_BASE:-http://127.0.0.1:18790}/api"
pass=0; fail=0

chk() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ✓ $1 ($3)";
  else fail=$((fail+1)); echo "  ✗ $1：期望 $2 实得 $3"; fi
}

req() { # req <method> <path> [token] [json-body]；token/body 缺省时用占位参数展开（set -u 下防 unbound）
  local m=$1 p=$2 t=${3:-} b=${4:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$m" "$BASE$p" -H 'content-type: application/json')
  if [ -n "$t" ]; then args+=(-H "authorization: Bearer $t"); fi
  if [ -n "$b" ]; then args+=(-d "$b"); fi
  curl "${args[@]}"
}
GET() { req GET "$1" "${2:-}"; }
POST() { req POST "$1" "${2:-}" "${3:-}"; }
PATCH() { req PATCH "$1" "${2:-}" "${3:-}"; }
DELETE() { req DELETE "$1" "${2:-}"; }

j() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)"; }

# ---------- 准备测试数据（loopback 无 token = owner） ----------

RUN_ID="matrix-$(date +%s)"
tripA=$(curl -s -X POST "$BASE/trips" -H 'content-type: application/json' -d "{\"title\":\"$RUN_ID-甲\",\"destinationCity\":\"杭州\"}")
TID_A=$(echo "$tripA" | j "['trip']['id']")
SHARE_A=$(echo "$tripA" | j "['trip']['shareToken']")
TID_B=$(curl -s -X POST "$BASE/trips" -H 'content-type: application/json' -d "{\"title\":\"$RUN_ID-乙\",\"destinationCity\":\"上海\"}" | j "['trip']['id']")
VIEWER=$SHARE_A # 迁移回填/建行程落库的默认 viewer 链接 token == shareToken
ed=$(curl -s -X POST "$BASE/trips/$TID_A/access-links" -H 'content-type: application/json' -d '{"role":"editor","label":"matrix 编辑链接"}')
EDITOR=$(echo "$ed" | j "['link']['token']")
EDLINK_ID=$(echo "$ed" | j "['link']['id']")
OWNER=$(curl -s -X POST "$BASE/owner-token/reset" | j "['token']")
cleanup() { curl -s -o /dev/null -X DELETE "$BASE/trips/$TID_A"; curl -s -o /dev/null -X DELETE "$BASE/trips/$TID_B"; }
trap cleanup EXIT

# ---------- 1. loopback 无 token：存量行为零回归 ----------

echo "== 1) loopback 无 token 照旧全通 =="
chk "GET /trips 列表" 200 "$(GET /trips)"
chk "GET bundle" 200 "$(GET /trips/$TID_A)"
chk "GET /settings" 200 "$(GET /settings)"
chk "GET /agents" 200 "$(GET /agents)"
chk "GET access-links" 200 "$(GET /trips/$TID_A/access-links)"
chk "GET /owner-token" 200 "$(GET /owner-token)"
chk "GET /config" 200 "$(GET /config)"
chk "GET share（老链接）" 200 "$(GET /share/$SHARE_A)"
chk "SSE events 无 token" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/trips/$TID_A/events")"

# ---------- 2. viewer（loopback + Bearer = 按 token 身份，不升 owner） ----------

echo "== 2) viewer（loopback + Bearer = 按 token 身份） =="
chk "bundle 读 200" 200 "$(GET /trips/$TID_A "$VIEWER")"
chk "budget 读 200" 200 "$(GET /trips/$TID_A/budget "$VIEWER")"
chk "suggest-clusters 200" 200 "$(GET /trips/$TID_A/suggest-clusters "$VIEWER")"
chk "SSE ?token= 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/trips/$TID_A/events?token=$VIEWER")"
chk "行程写 403（PATCH）" 403 "$(PATCH /trips/$TID_A "$VIEWER" '{"title":"viewer 改名"}')"
chk "建地点 403" 403 "$(POST /trips/$TID_A/places "$VIEWER" '{"name":"x","category":"other","location":{"lng":120.1,"lat":30.2}}')"
chk "budget 写 403" 403 "$(PATCH /trips/$TID_A/budget "$VIEWER" '{"budgetCny":100}')"
chk "search 403" 403 "$(GET "/trips/$TID_A/search?keyword=x" "$VIEWER")"
chk "跨行程 bundle 403" 403 "$(GET /trips/$TID_B "$VIEWER")"
chk "行程列表 403" 403 "$(GET /trips "$VIEWER")"
chk "settings 403" 403 "$(GET /settings "$VIEWER")"
chk "agents 403" 403 "$(GET /agents "$VIEWER")"
chk "删行程 403" 403 "$(DELETE /trips/$TID_A "$VIEWER")"
chk "chat-sessions events 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/chat-sessions/any/events?token=$VIEWER")"

# ---------- 3. editor ----------

echo "== 3) editor =="
chk "建地点 201" 201 "$(POST /trips/$TID_A/places "$EDITOR" '{"name":"editor 点","category":"restaurant","location":{"lng":120.15,"lat":30.25}}')"
chk "budget 写 200" 200 "$(PATCH /trips/$TID_A/budget "$EDITOR" '{"budgetCny":8000}')"
chk "PATCH 行程 200" 200 "$(PATCH /trips/$TID_A "$EDITOR" "{\"title\":\"$RUN_ID-甲-editor 改名\"}")"
chk "search 200" 200 "$(GET "/trips/$TID_A/search?keyword=x" "$EDITOR")"
chk "跨行程写 403" 403 "$(POST /trips/$TID_B/places "$EDITOR" '{"name":"x","category":"other","location":{"lng":121.4,"lat":31.2}}')"
chk "删行程 403" 403 "$(DELETE /trips/$TID_A "$EDITOR")"
chk "access-links 403" 403 "$(GET /trips/$TID_A/access-links "$EDITOR")"
chk "settings 403" 403 "$(GET /settings "$EDITOR")"

# ---------- 4. 吊销 / 无效 token ----------

echo "== 4) 吊销后 401 / 无效 token 401 =="
chk "无效 token 401" 401 "$(GET /trips/$TID_A not-a-token)"
chk "吊销 editor 链接 200" 200 "$(DELETE /access-links/$EDLINK_ID)"
chk "吊销后 editor token 401" 401 "$(GET /trips/$TID_A "$EDITOR")"
chk "吊销后 SSE ?token= 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/trips/$TID_A/events?token=$EDITOR")"

# ---------- 5. owner token ----------

echo "== 5) owner token =="
chk "owner token GET /trips 200" 200 "$(GET /trips "$OWNER")"
chk "owner token GET /settings 200" 200 "$(GET /settings "$OWNER")"
chk "owner token GET access-links 200" 200 "$(GET /trips/$TID_A/access-links "$OWNER")"
chk "owner token POST access-links 201" 201 "$(POST /trips/$TID_B/access-links "$OWNER" '{"role":"viewer"}')"

# ---------- 6. 老 share 链接脱敏结构 ----------

echo "== 6) 老 share 链接脱敏结构 =="
# 走临时文件而非管道（heredoc 会占 stdin，json.load(sys.stdin) 读不到 curl 输出）
curl -s "$BASE/share/$SHARE_A" > /tmp/yarnball-share-body.json
if python3 - <<'PYEOF'
import json, re
body = json.load(open("/tmp/yarnball-share-body.json"))
b = body["bundle"]
assert b["trip"]["id"] == "", "trip.id 应置空"
assert b["trip"]["shareToken"] == "", "shareToken 应置空"
assert body["budget"]["currency"] == "CNY", "budget 应随包"
for p in b["places"]:
    assert re.fullmatch(r"[0-9a-f]{16}", p["id"]), f"place id 应为 16 位别名: {p['id']}"
ids = {p["id"] for p in b["places"]}
for e in b["entries"]:
    if e.get("placeId"):
        assert e["placeId"] in ids, "entry.placeId 应映射到同一别名"
PYEOF
then
  echo "  ✓ 老 share 链接脱敏 bundle 结构不变（trip.id/shareToken 置空 + 16 位别名 + budget 齐全）"
else
  echo "  ✗ 老 share 链接结构异常"
  fail=$((fail+1))
fi
rm -f /tmp/yarnball-share-body.json

echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ] && echo "ALL MATRIX CHECKS PASSED" || exit 1
